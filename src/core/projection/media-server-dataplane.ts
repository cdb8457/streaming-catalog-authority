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
  /**
   * A PACED direct play, end to end: the five minutes the acceptance plan asks for, plus the startup it is
   * allowed, plus enough slack for the consumer container to be pulled, started and torn down.
   *
   * IT IS A CEILING ON A GATE THAT IS SUPPOSED TO TAKE FIVE MINUTES, which makes it a different shape of
   * deadline from every other one in this file. The others bound a wait for something that should be quick.
   * This one bounds a wait for something that must be SLOW — so it cannot be tight, and its job is only to
   * stop a wedged consumer from occupying the machine forever.
   */
  PACED_PLAY: 600_000,
  /** A five-minute forced transcode, consumed at the pace a player would consume it, plus the same slack. */
  TRANSCODE_SOAK: 900_000,
  /** ONE media-time seek: the master playlist, the variant playlist and the first segment at that position. */
  SEEK: 30_000,
} as const);

/** How long to sleep between polls of anything. Small enough to be responsive, large enough not to be a storm. */
export const MEDIA_SERVER_POLL_INTERVAL_MS = 1_000;

/**
 * How long the seek gate waits between one seek and the next.
 *
 * IT IS A CLIENT RATE, NOT A RETRY, AND THE DISTINCTION IS THE WHOLE JUSTIFICATION. Seeking makes the server
 * tear down its transcoding job and start a new one; measured against the pinned server, ten of those fired
 * back to back with no gap gets a **500 from the fourth**, because the previous job is still being disposed
 * of. No player produces that request rate and no person scrubbing produces it either — the gate was the
 * unrealistic party.
 *
 * It softens nothing. Each seek must still answer first time, and G9's ten seconds are measured around the
 * request itself, AFTER this wait, so the settle cannot absorb a slow seek.
 */
export const SEEK_SETTLE_MS = 2_000;

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
  /**
   * Provider bytes during one library scan for an object BELOW the contract's single-probe threshold, as a
   * multiple of that object's own length.
   *
   * WHY THIS IS NOT `MAX_SCAN_BYTE_FRACTION`, AND WHY PRETENDING OTHERWISE WOULD BE THE WORSE CHOICE. The
   * fraction budget carries the product's whole argument: a scanner that DOWNLOADED an object to identify it
   * would sit at 1.0, and the daemon is supposed to sit well below. That argument only exists for an object
   * big enough to have a middle and a tail. Below `SingleProbeBelowByte` the contract's own probe plan is a
   * single window covering the WHOLE object — so identifying such an entry costs its whole length by
   * construction, and a sub-1.0 budget over it would be a gate that could never pass however well the daemon
   * behaved. Applying the fraction to the corpus as one lump would hide that: the large entries would pay for
   * the small ones and a genuine regression in the large path could disappear into the average.
   *
   * So the two are budgeted separately, each against a denominator that names itself, and the small-object
   * multiplier is above 1.0 because reading a whole small object once is the CORRECT behaviour. What it still
   * catches is reading one several times.
   */
  MAX_SMALL_OBJECT_SCAN_BYTE_MULTIPLIER: 1.3,
} as const);

// ---------------------------------------------------------------------------------------------------------
// The five-minute gates, and the ten seeks
// ---------------------------------------------------------------------------------------------------------

/**
 * What G8, G9 and G10 of the acceptance plan actually ask for, as numbers rather than as prose.
 *
 * THESE ARE THE THRESHOLDS A "FIVE-MINUTE" CLAIM CAN BE FAKED AGAINST, so each one exists to close a specific
 * cheat rather than to be a round number:
 *
 *   - `MIN_DIRECT_PLAY_SECONDS` alone is passed by `curl file >/dev/null; sleep 300`. It is necessary and it
 *     is nowhere near sufficient.
 *   - `MAX_PACING_RATIO` is what makes it insufficient. A consumer that drained the whole file as fast as the
 *     socket allowed and then slept delivers hundreds of media-seconds per wall-second. A player delivers
 *     about one. The ceiling is above 1.0 only by the slack a real decoder needs.
 *   - `MIN_PACING_RATIO` closes the other direction: a consumer that slept for five minutes having decoded
 *     four seconds of video sits near zero and would otherwise pass every ceiling in this file.
 *   - `MAX_STALL_SECONDS` is the "without a stall" half of G8, which a start-and-end measurement cannot see
 *     at all: a play that froze for ninety seconds in the middle and caught up afterwards has the same
 *     endpoints as one that did not.
 */
export const MEDIA_SERVER_SOAK = Object.freeze({
  /** G8: "runs 5 minutes without a stall". Wall clock, and decoded media time, both. */
  MIN_DIRECT_PLAY_SECONDS: 300,
  /** G8: "direct play starts within 10 s" — from launching the consumer to its first decoded output. */
  MAX_STARTUP_SECONDS: 10,
  /** G8: the longest wall-clock interval in which decoded media time did not advance at all. */
  MAX_STALL_SECONDS: 15,
  /** G8: decoded media seconds per wall second. Above this the consumer downloaded rather than played. */
  MAX_PACING_RATIO: 1.35,
  /** G8: ...and below this it slept rather than played. */
  MIN_PACING_RATIO: 0.65,
  /** G10: "a forced transcode runs 5 minutes". Wall clock, and decoded h264 media time, both. */
  MIN_TRANSCODE_SECONDS: 300,
  /**
   * G10: the longest wall gap allowed between two consecutive transcoded segments arriving.
   *
   * THIS IS THE CONTINUITY ASSERTION, AND IT IS WHAT MAKES "FIVE MINUTES" MEAN SOMETHING. A window whose
   * first and last segment are five minutes apart is satisfied by consuming forty-nine segments in ten
   * seconds, sleeping for four minutes and fifty, and fetching one more. Requiring every ADJACENT pair to be
   * close together turns "five minutes elapsed" into "output was being consumed and decoded throughout five
   * minutes", which is the claim G10 is actually making.
   */
  MAX_SEGMENT_ARRIVAL_GAP_SECONDS: 20,
  /**
   * G10: how much of the required media must be decoded in the LAST THIRD of the wall window.
   *
   * A front-loaded run — everything decoded early, the tail padded out — passes both the span and the gap
   * ceiling if the tail is thin enough. This says the end of the window looks like the middle.
   */
  MIN_LATE_WINDOW_DECODED_FRACTION: 0.25,
  /**
   * G10: the share of successful session reads in which a session for this gate's device and item existed.
   *
   * It is a floor on the telemetry HAVING A SUBJECT rather than on what the telemetry said. A window in
   * which this gate's session was never present makes every session number beside it an absence dressed as
   * a measurement.
   */
  MIN_SESSION_PRESENT_SAMPLE_FRACTION: 0.8,
  /**
   * G10 HAS NO SESSION-SHARE THRESHOLD, AND THE ABSENCE IS THE POINT.
   *
   * There used to be a `MIN_TRANSCODE_METHOD_SAMPLE_FRACTION` here, requiring the server to report this
   * session's playback method as `Transcode` at 80 % of samples. The gate's own playback report was sending
   * `PlayMethod: 'Transcode'` at the time, so the threshold was measuring a claim this process had made.
   *
   * A three-arm negative control against a live pinned server -- with a genuine mpeg4 to h264 transcode
   * serving the segments in every arm -- decided it. Reporting `Transcode` read `DirectPlay` at t=0 and
   * `Transcode` at t=20s; reporting NOTHING read the same, so the server does derive a value when the client
   * asserts none; and reporting `DirectPlay` read **`DirectPlay` at both samples while the transcode ran**.
   * The client's contrary claim wins, so the field is client-writable and cannot carry an assertion about
   * what the server was doing.
   *
   * The gate now authors no `PlayMethod` at all, records what the server reports, and rests the transcode
   * claim on the decoded output: an asserted mpeg4 source and every consumed segment decoded as h264.
   */
  /** G9: "ten seeks". */
  SEEK_COUNT: 10,
  /** G9: "each producing playable video within 10 s". */
  MAX_SEEK_SECONDS: 10,
  /** G9: "including ... to > 90 % of duration". */
  DEEP_SEEK_FRACTION: 0.9,
  /** G9: how many of the ten transitions must go BACKWARDS. "Including backwards" is not "ends lower". */
  MIN_BACKWARD_SEEKS: 3,
  /**
   * G9: how far the position the server says it is serving may sit from the position asked for.
   *
   * A seek lands on a segment boundary, and the pinned server's segments are three seconds, so the honest
   * ceiling is a little over one segment. It is not zero and pretending it could be would make the gate fail
   * a correct server.
   */
  MAX_SEEK_POSITION_ERROR_SECONDS: 4,
  /**
   * G9: how much the decoded-timestamp offset may VARY across the ten seeks.
   *
   * Not how large it may be — see `decodedOffsetSpreadSeconds`. The offset is one server's presentation-time
   * convention; that it stays the same across ten positions is what proves the seeks went where they were
   * asked to.
   */
  MAX_SEEK_DECODED_OFFSET_SPREAD_SECONDS: 1.5,
  /** G9: how much of the media the ten decoded segments must span end to end. */
  MIN_SEEK_DECODED_SPAN_FRACTION: 0.8,
} as const);

/**
 * The ten seek positions, as fractions of the media's own duration.
 *
 * THEY ARE A CONSTANT RATHER THAN A LOOP OVER `i/10` BECAUSE THE ORDER IS THE EVIDENCE. A monotonically
 * increasing sweep is not what G9 asks for and is not what a person does to a player: it never asks the
 * server to seek backwards, which on this data plane is the read pattern most likely to be answered out of a
 * read-ahead buffer that happens to still be there. Two positions are beyond 90 % of duration, four
 * transitions go backwards, and `seekPlanProblems` refuses the list if a future edit flattens either
 * property — because a plan that quietly became a sweep would still pass every per-seek assertion.
 */
export const SEEK_PLAN_FRACTIONS: readonly number[] = Object.freeze([
  0.05, 0.93, 0.20, 0.62, 0.02, 0.41, 0.97, 0.15, 0.78, 0.33,
]);

/** The seek plan in seconds, against a real duration. Rounded to a tenth, which is finer than a keyframe. */
export function seekPositionsFor(durationSeconds: number): number[] {
  return SEEK_PLAN_FRACTIONS.map((fraction) => Math.round(fraction * durationSeconds * 10) / 10);
}

/**
 * Everything wrong with a seek plan, named.
 *
 * IT CHECKS THE SHAPE OF THE PLAN, NOT THE RESULT OF RUNNING IT. Every per-seek assertion in this gate — a
 * decodable segment inside ten seconds — would pass just as happily against ten seeks to the first minute of
 * the file. The properties that make the set worth running are properties of the LIST, and nothing that
 * observes one seek at a time can see them.
 */
export function seekPlanProblems(fractions: readonly number[]): string[] {
  const problems: string[] = [];
  // EXACTLY TEN, NOT AT LEAST TEN. G9 says ten seeks. A plan of eleven is not a stricter reading of it — it
  // is a different set, and the gate that reported "ten seeks" would be reporting a number it did not run.
  if (fractions.length !== MEDIA_SERVER_SOAK.SEEK_COUNT) {
    problems.push(`the plan has ${fractions.length} positions, not exactly ${MEDIA_SERVER_SOAK.SEEK_COUNT}`);
  }
  if (fractions.some((fraction) => !(fraction > 0 && fraction < 1))) {
    problems.push('a seek position is not strictly inside the media');
  }
  if (new Set(fractions).size !== fractions.length) {
    problems.push('two seek positions are the same, so one of them measures nothing new');
  }
  const deep = fractions.filter((fraction) => fraction > MEDIA_SERVER_SOAK.DEEP_SEEK_FRACTION).length;
  if (deep < 1) {
    problems.push(`no seek position is beyond ${MEDIA_SERVER_SOAK.DEEP_SEEK_FRACTION * 100}% of duration`);
  }
  let backward = 0;
  for (let index = 1; index < fractions.length; index += 1) {
    if ((fractions[index] as number) < (fractions[index - 1] as number)) backward += 1;
  }
  if (backward < MEDIA_SERVER_SOAK.MIN_BACKWARD_SEEKS) {
    problems.push(`the plan seeks backwards ${backward} times, not ${MEDIA_SERVER_SOAK.MIN_BACKWARD_SEEKS}`);
  }
  return problems;
}

/**
 * A tick is 100 nanoseconds, and it is the unit this server family states media positions in.
 *
 * IT IS HERE BECAUSE THE SEEK GATE READS POSITIONS OUT OF SERVER-GENERATED URLS. Each segment the media
 * server names in a variant playlist carries `runtimeTicks`: the server's own statement of where in the media
 * that segment begins. The gate converts it back to seconds and holds it against the position it asked for,
 * so "the server seeked to where it was told" is checked against the server's own arithmetic rather than
 * against a guess about segment lengths.
 */
export const TICKS_PER_SECOND = 10_000_000;

/**
 * HOW A SEEK IS ACTUALLY PERFORMED AGAINST THE PINNED SERVER, MEASURED RATHER THAN ASSUMED.
 *
 * The obvious spelling is `StartTimeTicks` on `master.m3u8`, and it is wrong here in two ways that were only
 * visible by running it against the pinned server:
 *
 *   1. IT DOES NOT CHANGE THE PLAYLIST. The variant playlist for a seeked request lists the WHOLE file —
 *      114 segments and 340 seconds of `#EXTINF` — exactly as an unseeked one does. So an assertion of the
 *      form "ask for 90 % of the way in and a tenth of the duration remains" is not a statement this server
 *      makes, and a gate built on it would be asserting a property of a different media server.
 *   2. THE SEGMENT REQUEST THEN FAILS. The server generates child URLs in the shape of the request that
 *      asked for them, so `startTimeTicks` propagates into every segment URL, lands beside the
 *      `runtimeTicks` the playlist generator adds, and the segment endpoint answers **400**.
 *
 * WHAT AN HLS CLIENT ACTUALLY DOES, and therefore what this gate does: it takes the one playlist, and to seek
 * it REQUESTS THE SEGMENT AT THE POSITION IT WANTS — out of order, backwards, wherever. The server restarts
 * its encoder at that position to answer, which is precisely the non-sequential, multi-position read this
 * data plane exists to make cheap. Measured: ten such requests, every one answered under a second, every one
 * a distinct segment, and every one decoding to a picture whose timestamps sit at the position asked for.
 */
export const SEEK_IS_A_DIRECT_SEGMENT_REQUEST = true;

/** One seek: what was asked for, what the server said it was answering, and what came back. */
export interface SeekObservation {
  readonly index: number;
  readonly requestedSeconds: number;
  /** Where the SERVER said this segment starts, read out of the URL the server generated for it. */
  readonly serverPositionSeconds: number;
  readonly elapsedMs: number;
  readonly bytes: number;
  /** So that ten seeks returning the same segment ten times cannot pass as ten seeks. */
  readonly sha256: string;
}

/** What decoding a seek's segment found, produced outside the process that fetched it. */
export interface SeekDecode {
  readonly index: number;
  readonly codec: string;
  readonly packets: number;
  /** The decoded picture's own start timestamp. The temporal evidence. */
  readonly startSeconds: number;
}

export interface SeekSetAnalysis {
  readonly count: number;
  readonly slowestSeconds: number;
  readonly distinctSegments: number;
  readonly backwardTransitions: number;
  readonly deepSeeks: number;
  /** The worst gap between the position asked for and the position the server said it was serving. */
  readonly maxPositionErrorSeconds: number;
  readonly unprobed: number;
  readonly wrongCodec: number;
  readonly emptyOfVideo: number;
  /**
   * How much the (decoded start - server position) offset VARIED across the ten seeks.
   *
   * THIS IS THE TEMPORAL ASSERTION, AND IT IS SHAPED THIS WAY ON PURPOSE. The pinned server emits transport
   * streams on a fixed presentation-time base, so a segment for media second 315 decodes with a start time of
   * 325: there is a constant offset, and hard-coding it would be hard-coding one server's PTS convention into
   * an acceptance gate. What is universal is that the offset is CONSTANT — the decoded timestamps move one
   * second per second of media asked for. A server that ignored the position and returned the same segment
   * ten times, or that returned segments in some order of its own, produces an offset that varies by as much
   * as the duration of the media.
   */
  readonly decodedOffsetSpreadSeconds: number;
  /** How much of the media the decoded timestamps actually covered end to end. */
  readonly decodedSpanSeconds: number;
}

/**
 * Ten seeks, held against what "ten seeks including backwards and past 90 %" has to mean.
 *
 * EVERY PER-SEEK ASSERTION IS PASSABLE BY A SERVER THAT NEVER SEEKED. A 200, a non-empty body, a decodable
 * h264 segment and a ten-second ceiling are all satisfied by returning the first three seconds of the file
 * ten times over. The four properties that are not — distinct segments, a constant decoded offset, a decoded
 * span covering the media, and a position the server itself agrees with — belong to the SET, and nothing that
 * watches one seek at a time can see any of them.
 */
export function analyseSeekSet(
  seeks: readonly SeekObservation[], decodes: readonly SeekDecode[],
): SeekSetAnalysis {
  const byIndex = new Map(decodes.map((decode) => [decode.index, decode]));
  const offsets: number[] = [];
  const starts: number[] = [];
  for (const seek of seeks) {
    const decode = byIndex.get(seek.index);
    if (decode === undefined) continue;
    offsets.push(decode.startSeconds - seek.serverPositionSeconds);
    starts.push(decode.startSeconds);
  }
  let backward = 0;
  for (let index = 1; index < seeks.length; index += 1) {
    if ((seeks[index] as SeekObservation).requestedSeconds
      < (seeks[index - 1] as SeekObservation).requestedSeconds) backward += 1;
  }
  const spread = (values: readonly number[]): number =>
    (values.length === 0 ? Infinity : Math.max(...values) - Math.min(...values));
  const span = starts.length === 0 ? 0 : Math.max(...starts) - Math.min(...starts);
  const deepest = seeks.length === 0 ? 0 : Math.max(...seeks.map((seek) => seek.requestedSeconds));
  return {
    count: seeks.length,
    slowestSeconds: seeks.length === 0
      ? Infinity : Math.max(...seeks.map((seek) => seek.elapsedMs)) / 1_000,
    distinctSegments: new Set(seeks.map((seek) => seek.sha256)).size,
    backwardTransitions: backward,
    // A DEEP SEEK IS ONE PAST 90 % OF WHAT WAS ACTUALLY REACHED, which is the only duration this pure
    // function can see. The gate additionally checks the plan against the media's real duration.
    deepSeeks: seeks.filter((seek) =>
      seek.requestedSeconds > deepest * MEDIA_SERVER_SOAK.DEEP_SEEK_FRACTION).length,
    maxPositionErrorSeconds: seeks.length === 0 ? Infinity
      : Math.max(...seeks.map((seek) => Math.abs(seek.requestedSeconds - seek.serverPositionSeconds))),
    unprobed: seeks.filter((seek) => !byIndex.has(seek.index)).length,
    wrongCodec: decodes.filter((decode) => decode.codec !== TRANSCODE_TARGET_VIDEO_CODEC).length,
    emptyOfVideo: decodes.filter((decode) => decode.packets <= 0).length,
    decodedOffsetSpreadSeconds: spread(offsets),
    decodedSpanSeconds: span,
  };
}

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
// What a five-minute play actually looked like
// ---------------------------------------------------------------------------------------------------------

/** One progress record from the paced consumer: when it was emitted, and how much media had been decoded. */
export interface PacedSample {
  /** Milliseconds since the consumer was LAUNCHED, not since it first produced output. */
  readonly wallMs: number;
  /** Decoded output position in milliseconds, as the consumer itself reports it. */
  readonly mediaMs: number;
  /** Frames decoded and written so far. Zero means the pipeline has not produced anything yet. */
  readonly frames: number;
}

export interface PacedPlaybackAnalysis {
  readonly samples: number;
  /** Seconds from launch to the first record carrying real output. `Infinity` if there never was one. */
  readonly startupSeconds: number;
  /** Wall seconds from launch to the last record. */
  readonly wallSeconds: number;
  /** Decoded media seconds at the last record. */
  readonly mediaSeconds: number;
  /** The longest wall interval, after startup, in which the media position did not move. */
  readonly longestStallSeconds: number;
  /** Decoded media seconds per wall second, after startup. One is a player; a hundred is a download. */
  readonly pacingRatio: number;
}

/**
 * Turn a consumer's progress trace into the four numbers G8 is actually about.
 *
 * IT IS PURE, AND THAT IS WHY THE CHEATS CAN BE TESTED. The three ways to pass a five-minute playback gate
 * without playing anything for five minutes — drain the file and sleep, sleep and decode nothing, freeze in
 * the middle and catch up — are all shapes of trace, and a pure function over a trace can be handed each of
 * them offline and required to reject it. A checker that lived inside the phase that spawns ffmpeg could only
 * ever be tested by spawning ffmpeg.
 *
 * THE RATIO IS MEASURED FROM THE FIRST OUTPUT, NOT FROM LAUNCH. Container start and stream negotiation are
 * dead wall-clock with no media in them; charging them against the ratio would make a correct run look slow
 * and would tempt somebody into widening the ceiling until it stopped meaning anything. Startup gets its own
 * assertion instead, which is what the acceptance plan asks for anyway.
 */
export function analysePacedPlayback(samples: readonly PacedSample[]): PacedPlaybackAnalysis {
  const ordered = [...samples].sort((a, b) => a.wallMs - b.wallMs);
  const first = ordered.find((sample) => sample.frames > 0 && sample.mediaMs > 0);
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) {
    return {
      samples: ordered.length, startupSeconds: Infinity, wallSeconds: 0, mediaSeconds: 0,
      longestStallSeconds: Infinity, pacingRatio: 0,
    };
  }
  let longestStallMs = 0;
  let lastAdvanceWallMs = first.wallMs;
  let lastMediaMs = first.mediaMs;
  for (const sample of ordered) {
    if (sample.wallMs < first.wallMs) continue;
    if (sample.mediaMs > lastMediaMs) {
      lastMediaMs = sample.mediaMs;
      lastAdvanceWallMs = sample.wallMs;
      continue;
    }
    // THE STALL IS MEASURED FROM THE LAST TIME THE MEDIA MOVED, not between adjacent samples. A consumer
    // that emits a record every second while frozen would otherwise report ten one-second stalls instead of
    // one ten-second one, and the ceiling would never be reached however long the freeze lasted.
    longestStallMs = Math.max(longestStallMs, sample.wallMs - lastAdvanceWallMs);
  }
  // ...including a freeze that lasted until the consumer was stopped, which has no later sample to close it.
  longestStallMs = Math.max(longestStallMs, last.wallMs - lastAdvanceWallMs);

  const wallSeconds = last.wallMs / 1_000;
  const mediaSeconds = last.mediaMs / 1_000;
  const pacedWallMs = Math.max(1, last.wallMs - first.wallMs);
  const pacedMediaMs = Math.max(0, last.mediaMs - first.mediaMs);
  return {
    samples: ordered.length,
    startupSeconds: first.wallMs / 1_000,
    wallSeconds,
    mediaSeconds,
    longestStallSeconds: longestStallMs / 1_000,
    pacingRatio: pacedMediaMs / pacedWallMs,
  };
}

// ---------------------------------------------------------------------------------------------------------
// What a five-minute transcode actually looked like
// ---------------------------------------------------------------------------------------------------------

/** One segment the paced transcode client asked for and received. */
export interface SoakSegment {
  readonly index: number;
  /** Milliseconds from the start of the soak to this segment's body being fully received. */
  readonly wallMs: number;
  /** Where in the media this segment starts, from the playlist the server generated. */
  readonly mediaStartSeconds: number;
  readonly bytes: number;
  /** So that a window of one segment delivered fifty times cannot pass as fifty segments. */
  readonly sha256: string;
}

/** What decoding one of those segments found. Produced OUTSIDE this process, by an actual decoder. */
export interface SoakProbe {
  readonly index: number;
  readonly codec: string;
  readonly packets: number;
  readonly seconds: number;
}

export interface TranscodeSoakAnalysis {
  readonly segments: number;
  readonly probed: number;
  /** Segments the gate consumed but did not decode. Any at all makes the decoded total a lower bound only. */
  readonly unprobed: number;
  /** Distinct segment bodies. Fifty deliveries of one segment is not fifty segments. */
  readonly distinctSegments: number;
  /** Wall seconds between the first and last segment arriving. */
  readonly wallSpanSeconds: number;
  /** The longest wall gap between two ADJACENT arrivals. This is what makes the span continuous. */
  readonly maxArrivalGapSeconds: number;
  /** Decoded media seconds, summed over probed segments. This is evidence about the OUTPUT. */
  readonly decodedMediaSeconds: number;
  /** Decoded media seconds among the segments that arrived in the LAST THIRD of the wall window. */
  readonly lateWindowDecodedSeconds: number;
  /** Probed segments whose video was not the codec the transcode was forced to. */
  readonly wrongCodec: number;
  /** Probed segments with no decodable video packets in them. */
  readonly emptyOfVideo: number;
  /**
   * Wall seconds spanned by the ENCODER'S own output files, and how many there were.
   *
   * RECORDED, NOT ASSERTED, AND THE REASON IS A MEASUREMENT. An earlier version of this gate required this
   * span to cover most of the window, on the theory that a throttled encoder stays a bounded distance ahead
   * of its client and therefore keeps working for as long as the client keeps consuming. Measured against the
   * pinned server with throttling enabled: 115 output files written inside **1.6 seconds**. The encoder
   * transcodes a five-minute low-bitrate source almost instantly and exits; throttling did not hold it back.
   *
   * So a five-minute span here is not a property of a correct run, and requiring it would have been a gate
   * that fails when nothing is wrong. What this number honestly says is HOW FAR AHEAD OF THE PACED CLIENT the
   * encoder ran, and it is reported under that description. The five-minute claim rests on the continuity of
   * DECODED OUTPUT instead — see `maxArrivalGapSeconds` and `lateWindowDecodedSeconds`.
   */
  readonly encoderAheadSpanSeconds: number;
  readonly encoderOutputFiles: number;
  /**
   * Samples in which the server reported this session's `PlayState.PlayMethod` as `Transcode`.
   *
   * RECORDED, NEVER ASSERTED. This comment used to read "ASSERTED", and it was stale in the direction that
   * matters: it described the number as the evidence carrying G10 after the assertion on it had been
   * removed for being circular -- the gate was sending `PlayMethod: 'Transcode'` and reading it back. A
   * negative control showed the field is client-writable; see `TranscodeSessionSample.methodIsTranscode`
   * in the driver for the three arms. The transcode claim rests on the decoded output.
   */
  readonly transcodeMethodSamples: number;
  /**
   * Samples in which the server was reporting LIVE `TranscodingInfo`.
   *
   * RECORDED, NOT ASSERTED. Measured: it is populated immediately after the job starts and null fifteen
   * seconds later, because the encoder finishes the whole source in 1.6 seconds and exits. It is a
   * live-encoder signal, and requiring a share of it would be requiring encoder liveness — the very claim
   * this gate does not make.
   */
  readonly encoderLiveSamples: number;
  /**
   * Samples in which a session for this gate's own device and item existed at all.
   *
   * WITHOUT IT THE TWO NUMBERS ABOVE CANNOT BE READ. `methodIsTranscode` and `encoderJobLive` are both
   * false for "no session of ours exists" and for "one exists and is neither of those things", so a window
   * that never had a session produces the same zeros as a window that had one and was direct-playing.
   */
  readonly sessionPresentSamples: number;
  /** Successful session reads. A poll that FAILED is not one of these -- see `analyseTranscodeSoak`. */
  readonly sessionSamples: number;
}

/** One sample of the server's account of a playing item. Two facts that behave completely differently. */
export interface TranscodeSessionSampleRecord {
  readonly methodIsTranscode: boolean;
  readonly encoderJobLive: boolean;
  readonly sessionPresent: boolean;
}

/**
 * What one five-minute forced transcode actually looked like, in numbers that each close a different cheat.
 *
 *   - `wallSpanSeconds` is defeated on its own by consuming everything in ten seconds and sleeping.
 *   - `maxArrivalGapSeconds` closes that: every ADJACENT pair of segments has to arrive close together, so
 *     the five minutes is five minutes of consumption rather than five minutes of elapsed time.
 *   - `decodedMediaSeconds`, `wrongCodec` and `emptyOfVideo` are the OUTPUT, decoded by a real decoder — a
 *     count of segment files would be satisfied by a server that emitted anything at all.
 *   - `lateWindowDecodedSeconds` closes the front-loaded run, where everything real happens early and the
 *     tail is padded.
 *   - `distinctSegments` closes one segment delivered fifty times, which satisfies every number above.
 *
 * WHAT IS NOT HERE, AND WHY. There is no assertion that the ENCODER PROCESS was busy for five minutes,
 * because on the pinned server it is not — see `encoderAheadSpanSeconds`. This gate claims five minutes of
 * paced, continuously decoded, transcoded playback, and that is exactly what it measures.
 */
export function analyseTranscodeSoak(
  segments: readonly SoakSegment[],
  probes: readonly SoakProbe[],
  outputMtimesMs: readonly number[],
  sessions: readonly TranscodeSessionSampleRecord[],
): TranscodeSoakAnalysis {
  const ordered = [...segments].sort((a, b) => a.wallMs - b.wallMs);
  const firstWall = ordered[0]?.wallMs ?? 0;
  const lastWall = ordered[ordered.length - 1]?.wallMs ?? 0;
  const byIndex = new Map(probes.map((probe) => [probe.index, probe]));
  const mtimes = [...outputMtimesMs].sort((a, b) => a - b);

  let maxGapMs = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    maxGapMs = Math.max(maxGapMs,
      (ordered[index] as SoakSegment).wallMs - (ordered[index - 1] as SoakSegment).wallMs);
  }
  // The first arrival is measured from the start of the soak too: a run whose first segment took four
  // minutes to appear has a gap in it, and it is at the front.
  maxGapMs = Math.max(maxGapMs, firstWall);

  const lateFrom = firstWall + ((lastWall - firstWall) * 2) / 3;
  const lateWindowDecodedSeconds = ordered
    .filter((segment) => segment.wallMs >= lateFrom)
    .reduce((total, segment) => total + (byIndex.get(segment.index)?.seconds ?? 0), 0);

  return {
    segments: ordered.length,
    probed: probes.length,
    unprobed: ordered.filter((segment) => !byIndex.has(segment.index)).length,
    distinctSegments: new Set(ordered.map((segment) => segment.sha256)).size,
    wallSpanSeconds: (lastWall - firstWall) / 1_000,
    maxArrivalGapSeconds: ordered.length === 0 ? Infinity : maxGapMs / 1_000,
    decodedMediaSeconds: probes.reduce((total, probe) => total + probe.seconds, 0),
    lateWindowDecodedSeconds,
    wrongCodec: probes.filter((probe) => probe.codec !== TRANSCODE_TARGET_VIDEO_CODEC).length,
    emptyOfVideo: probes.filter((probe) => probe.packets <= 0).length,
    encoderAheadSpanSeconds: mtimes.length < 2
      ? 0 : (((mtimes[mtimes.length - 1] as number) - (mtimes[0] as number)) / 1_000),
    encoderOutputFiles: mtimes.length,
    transcodeMethodSamples: sessions.filter((sample) => sample.methodIsTranscode).length,
    encoderLiveSamples: sessions.filter((sample) => sample.encoderJobLive).length,
    sessionPresentSamples: sessions.filter((sample) => sample.sessionPresent).length,
    // ONLY SUCCESSFUL READS ARRIVE HERE. A poll that failed is counted by the caller as a failed poll and
    // is never pushed as a sample, because "the server said no" and "we could not ask" are different facts.
    sessionSamples: sessions.length,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------------------------------------

/** What the control plane published, as the gate recorded it BEFORE anything was mounted. */
export interface CorpusExpectation {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly kind: 'local' | 'http-range';
  /** An entry whose bytes are additionally read back and digest-compared, rather than only catalogued. */
  readonly anchor?: boolean;
}

/** What the media server says it found. Only the fields a corpus assertion is entitled to look at. */
export interface CorpusObservation {
  readonly key: string;
  readonly sizeBytes: number;
  readonly ordinaryFile: boolean;
}

export interface CorpusProblems {
  /** Expected entries the media server did not catalogue at all. */
  readonly missing: number;
  /** Entries it catalogued at a size the control plane did not publish. */
  readonly wrongSize: number;
  /** Entries it catalogued as something other than an ordinary local file. */
  readonly notOrdinary: number;
  /** Entries it catalogued twice. */
  readonly duplicated: number;
  /** Entries it catalogued that were never published. */
  readonly unexpected: number;
  /** Expected entries matched, at the right size, as ordinary files. The number the gate actually asserts. */
  readonly matched: number;
}

/**
 * Compare a ~50-entry corpus against what a media server catalogued, in one pass.
 *
 * WHY THIS IS AGGREGATE AND THE ANCHORS ARE NOT. Fifty entries times four properties times seven scans is
 * fourteen hundred report lines, and a report nobody reads is a report that hides a regression as well as a
 * silent one does. But the aggregate has to be a COUNT OF MATCHES, not a count of items: a listing of fifty
 * arbitrary files has the right length, and "the scan found fifty things" is not "the scan found the fifty
 * things that were published". `matched` only counts an expected key that was present, at the published
 * size, as an ordinary file — so it can only reach fifty if all fifty identities were genuinely observed.
 */
export function corpusProblems(
  expected: readonly CorpusExpectation[], observed: readonly CorpusObservation[],
): CorpusProblems {
  const counts = new Map<string, number>();
  for (const item of observed) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  const byKey = new Map(observed.map((item) => [item.key, item]));
  const expectedKeys = new Set(expected.map((entry) => entry.key));

  let missing = 0; let wrongSize = 0; let notOrdinary = 0; let matched = 0;
  for (const entry of expected) {
    const item = byKey.get(entry.key);
    if (item === undefined) { missing += 1; continue; }
    const sized = item.sizeBytes === entry.sizeBytes;
    if (!sized) wrongSize += 1;
    if (!item.ordinaryFile) notOrdinary += 1;
    if (sized && item.ordinaryFile) matched += 1;
  }
  return {
    missing, wrongSize, notOrdinary, matched,
    duplicated: [...counts.values()].filter((count) => count > 1).length,
    unexpected: [...counts.keys()].filter((key) => !expectedKeys.has(key)).length,
  };
}

/**
 * Everything wrong with the corpus itself, before a media server is involved.
 *
 * TWO ENTRIES WITH THE SAME BYTES MAKE EVERY LATER DIGEST COMPARISON DECORATIVE: a read that returned the
 * wrong file would still match. The two-entry version of this gate asserted it inline; a fifty-entry corpus
 * generated from a loop needs it asserted over the whole set, because the loop is exactly the thing that
 * could quietly start producing identical parameters.
 */
export function corpusSelfProblems(expected: readonly CorpusExpectation[]): string[] {
  const problems: string[] = [];
  if (new Set(expected.map((entry) => entry.key)).size !== expected.length) {
    problems.push('two corpus entries have the same file name');
  }
  const digests = new Set(expected.map((entry) => entry.sha256));
  if (digests.size !== expected.length) {
    problems.push(`the corpus has ${expected.length} entries but only ${digests.size} distinct digests, `
      + 'so a read that returned the wrong entry could still match');
  }
  if (expected.some((entry) => entry.sizeBytes <= 0)) problems.push('a corpus entry has no bytes');
  return problems;
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

/**
 * What one observation of the scan task means.
 *
 * `indeterminate` IS NOT A HAIR-SPLIT, IT IS THE FOURTH ANSWER THAT WAS MISSING. An execution has been
 * recorded, but the task's state is not one this code recognises: it is therefore neither finished (that
 * needs `Idle`) nor demonstrably under way (that needs `Running` or `Cancelling`).
 *
 * With only three phases that case had to be squeezed into one of them, and it was squeezed into `running` —
 * the exact phase the in-flight callback fires on. So an unknown state such as `Restarting` alongside a new
 * execution timestamp raised the mid-scan marker, even though the previous fix had made `observedInFlight`
 * correctly stay false. The guard before the publish caught it, so no false publish could occur; but the
 * callback contract said "only authoritative Running or Cancelling raises this" and the code did not, which
 * makes the contract and its tests wrong regardless of what the next check happens to catch.
 */
export type ScanPhase = 'not-started' | 'running' | 'indeterminate' | 'complete';

/**
 * The scheduled-task states that mean an execution is UNDER WAY on the pinned media server.
 *
 * These two and nothing else. In particular NOT "a progress percentage is present": on the pinned server the
 * task's state is derived from whether a cancellation token source exists, and completion clears that token
 * source BEFORE it clears the progress figure. A response serialized between those two writes reports `Idle`
 * with a stale non-null progress, which is a scan that has just ENDED. Treating it as motion would let a
 * finished scan satisfy every "while the scan was running" claim in this gate.
 */
const IN_FLIGHT_TASK_STATES: ReadonlySet<string> = new Set(['Running', 'Cancelling']);

/** Whether a scheduled-task state means the execution is under way right now. */
export function isInFlightState(state: string | undefined): boolean {
  return state !== undefined && IN_FLIGHT_TASK_STATES.has(state);
}

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
  /**
   * TWO FACTS, NOT ONE, AND CONFLATING THEM IS THE DEFECT THIS SPLIT CLOSES.
   *
   * `executionObserved` means AN EXECUTION HAPPENED — which a fast-complete proves perfectly well, and which
   * is all an ordinary "wait for the scan to finish" needs.
   *
   * `inFlightObserved` means THIS PROCESS ACTUALLY SAW THE SCANNER RUNNING — a sample that said `Running`,
   * or reported progress, or was mid-execution. A scan that started and finished between two polls sets the
   * first and MUST NOT set the second.
   *
   * They used to be one flag. Every branch set it, including the fast-complete one, so a scan nobody ever saw
   * in flight satisfied `started`; `onRunning` fired on it, the mid-scan gate's marker appeared, and the
   * publish that followed was claimed to have landed WHILE A SCAN WAS RUNNING when it may well have landed
   * after the scan was over. The claim was the strongest one in that gate and it was the one least supported.
   */
  private executionObserved = false;
  private inFlightObserved = false;
  private finished = false;

  constructor(private readonly baselineStart: string | undefined) {}

  /** The phase implied by one sample. Monotonic: neither `running` nor `complete` is ever forgotten. */
  observe(sample: ScanTaskSample | undefined): ScanPhase {
    // Once a new execution has been seen to END, nothing later un-ends it.
    if (this.finished) return 'complete';
    if (sample === undefined) {
      if (this.inFlightObserved) return 'running';
      return this.executionObserved ? 'indeterminate' : 'not-started';
    }
    const state = sample.State ?? '';
    const start = sample.LastExecutionResult?.StartTimeUtc;
    const startedSinceBaseline = ScanBarrier.isAfter(start, this.baselineStart);

    // POSITIVE, PRESENT-TENSE EVIDENCE OF MOTION, AND ONLY THE AUTHORITATIVE FIELD COUNTS.
    //
    // PROGRESS IS NOT MOTION, WHICH TOOK A THIRD REVIEW TO SEE. This used to accept any non-null
    // `CurrentProgressPercentage` as running, including alongside `State: 'Idle'`. On the pinned server the
    // task's `State` is derived from whether a cancellation token source exists, and completion clears that
    // token source BEFORE it clears the progress figure — so a serialization that lands between the two
    // legitimately reports Idle with a stale, non-null progress number. That sample is a scan that has just
    // FINISHED, and reading it as motion is exactly the false positive this whole barrier exists to prevent.
    //
    // So only the state field, and only the two values that mean an execution is under way. If a future
    // pinned server proves another state belongs here, it goes in with the evidence, not on the strength of
    // a field that looks suggestive.
    if (isInFlightState(state)) {
      this.executionObserved = true;
      this.inFlightObserved = true;
      return 'running';
    }
    // Idle AND a new execution has been recorded: the scan ran and is over. Both halves are required —
    // idle alone is the stale-idle trap, and a new start time alone could still be in flight.
    //
    // NOTE WHAT IS NOT SET HERE. If this is the first sample that moved, the scan started and finished
    // between two polls and this process never saw it running. That is a valid COMPLETION and an invalid
    // in-flight observation, and the two now say so separately.
    if (state === 'Idle' && startedSinceBaseline) {
      this.executionObserved = true;
      this.finished = true;
      return 'complete';
    }
    // A new execution has been recorded under a state this code does not recognise. It is not complete (that
    // needs Idle) and it is not evidence of motion (that needs Running or Cancelling), so the wait continues
    // and NOTHING is claimed from it — not `inFlightObserved`, and not the phase that fires the callback.
    if (startedSinceBaseline) {
      this.executionObserved = true;
      return 'indeterminate';
    }
    if (this.inFlightObserved) return 'running';
    // An execution was recorded earlier under a state we could not read, and this sample adds nothing. Still
    // waiting, still claiming nothing.
    return this.executionObserved ? 'indeterminate' : 'not-started';
  }

  /** Whether an execution has been observed to have happened, in flight or between polls. */
  get executionSeen(): boolean { return this.executionObserved; }

  /**
   * Whether the scanner was seen ACTUALLY RUNNING by this observer.
   *
   * This is the only property any "while a scan was running" claim may rest on.
   */
  get observedInFlight(): boolean { return this.inFlightObserved; }

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
