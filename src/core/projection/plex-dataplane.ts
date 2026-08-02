import {
  MEDIA_SERVER_BUDGETS, MEDIA_SERVER_SOAK, TRANSCODE_SOURCE_VIDEO_CODEC, TRANSCODE_TARGET_VIDEO_CODEC,
} from './media-server-dataplane.js';

// Projection Phase 1 — the PLEX data-plane contract.
//
// WHAT THIS FILE IS. The pure half of the second gate in which a real media server reads the projected mount,
// and the first one that is not Jellyfin. It holds the request shapes, the server preferences, the scan
// barrier, the "this is an ordinary file" predicate and the encoder-liveness analysis that
// `deploy/projection-plex-dataplane-gate.sh` enforces. It opens no socket, reads no clock and touches no
// filesystem, so every rule here is checkable offline.
//
// WHAT IT DELIBERATELY DOES NOT DO: restate anything `media-server-dataplane.ts` already holds. The deadlines,
// the amplification budgets, the five-minute thresholds, the ten-seek plan, the corpus comparison, the
// redaction rule and the verdict helpers are SERVER-AGNOSTIC — they are statements about what a five-minute
// claim has to mean and what a report may contain, not about any server's API — and they are imported by the
// Plex driver from there unchanged. What lives here is everything whose truth depends on Plex.
//
// WHY IT IS NOT A COPY OF THE JELLYFIN MODULE, AND WHY THAT MATTERS MORE THAN THE DUPLICATION IT AVOIDS.
// Almost every Jellyfin request shape in this repository is wrong for Plex, and two of the Jellyfin gate's
// hardest-won conclusions are wrong for Plex in the other direction:
//
//   - Jellyfin's `PlayState.PlayMethod` is CLIENT-WRITABLE — a client reporting `DirectPlay` while a genuine
//     transcode serves it is recorded as `DirectPlay` — so the Jellyfin gate rests its transcode claim on
//     decoded output alone. Plex has no client-writable play-method field at all: see
//     `PLEX_HAS_NO_CLIENT_WRITABLE_PLAY_METHOD`. That does not license trusting the server's bookkeeping, and
//     this gate still rests its transcode claim on decoded output — but the reasons differ and neither
//     document may be copied into the other.
//   - Jellyfin's encoder finishes a five-minute low-bitrate source in about 1.6 seconds and exits, so the
//     Jellyfin gate RECORDS encoder lifetime and asserts nothing about it. Plex throttles: measured against
//     the pinned server, the transcode session stays incomplete and its `maxOffsetAvailable` keeps advancing
//     for as long as a paced client keeps consuming. So this gate CAN assert a bounded encoder-liveness
//     claim, and does — see `analysePlexEncoderLiveness`. Carrying Jellyfin's non-claim over would have been
//     the same failure as carrying its claim over: a document that disagrees with what runs.
//
// EVERY CONSTANT BELOW THAT DESCRIBES PLEX'S BEHAVIOUR WAS MEASURED against the pinned server named in
// `deploy/projection-plex-dataplane-gate.sh`, not read off a wiki. Where the measurement contradicted the
// obvious spelling, the measurement and the obvious spelling are both recorded, because the next person to
// reach for the obvious spelling deserves to find out here rather than by running it.

// ---------------------------------------------------------------------------------------------------------
// Getting a real Plex to answer at all, without anybody's Plex account
// ---------------------------------------------------------------------------------------------------------

/**
 * WHETHER THIS GATE NEEDS A PLEX ACCOUNT: no. WHETHER IT NEEDS THE INTERNET: **no** — and getting that
 * second answer right took retracting the first answer this file gave.
 *
 * An UNCLAIMED Plex Media Server — one with no `PLEX_CLAIM` token, no `PlexOnlineMail` and no
 * `PlexOnlineToken` — answers a local address with **no credential at all**. That is what lets this gate run
 * against a real Plex without asking anybody for their personal credentials, and the gate asserts
 * `claimed="0"` rather than assuming it.
 *
 * WHAT THIS COMMENT USED TO SAY, AND WHY IT WAS WRONG. It said an unclaimed Plex answers 401 to everything
 * but `/identity` unless it can reach plex.tv, and it cited three measurements. All three were real
 * observations and the conclusion drawn from them was false, because every one of them addressed the server
 * **by its Docker container name** — and the refusal had nothing to do with plex.tv. See
 * `PLEX_REJECTS_UNRECOGNISED_HOST_HEADER`.
 *
 * WHAT THE CORRECTED MEASUREMENT COVERS, AND EXACTLY THAT. On a network created `--internal`, with DNS for
 * `servers.plex.tv` failing inside the container throughout and the server addressed **by IP**, these four
 * requests were made and no others:
 *
 *   `GET /` 200 | `GET /library/sections` 200 | `GET /:/prefs` 200 | `POST /library/sections` 201
 *
 * So what is established is: **an unclaimed Plex with no route to the internet answers the endpoints needed
 * to inspect and create a library.** It is NOT established that scanning, direct play, seeking or
 * transcoding work air-gapped — this gate has never run that way, because Docker Desktop cannot publish a
 * port from an internal network and its driver reaches the server through one. `PLEX_AIR_GAPPED_TESTED_PATHS`
 * is the exact list, so the claim cannot drift upward into "the whole local API".
 *
 * The three original observations are kept in the document rather than deleted, because a confounded
 * experiment that produced a confident wrong conclusion is worth more as a record than as an absence.
 */
export const PLEX_UNCLAIMED_LOCAL_API_REQUIRES_PLEX_TV_REACHABILITY = false;

/**
 * The exact requests that were made against an air-gapped unclaimed Plex, and therefore the exact extent of
 * the claim. Anything not on this list is not covered by it.
 */
export const PLEX_AIR_GAPPED_TESTED_PATHS: readonly string[] = Object.freeze([
  'GET /',
  'GET /library/sections',
  'GET /:/prefs',
  'POST /library/sections',
]);

/**
 * PLEX REFUSES A REQUEST WHOSE `Host` HEADER IS A NAME IT DOES NOT RECOGNISE, AND THAT IS THE WHOLE OF IT.
 *
 * Measured, with everything else held identical — same network, same peer, same unclaimed server:
 *
 *   | request                                    | answer |
 *   |--------------------------------------------|--------|
 *   | `http://<container-name>:32400/library/sections` | **401** |
 *   | `http://<container-ip>:32400/library/sections`   | **200** |
 *   | `http://<container-ip>:...` with `Host: <name>`  | **401** |
 *   | `http://<container-name>:...` with `Host: <ip>`  | **200** |
 *   | `http://<container-name>:...` with `Host: localhost:32400` | **200** |
 *
 * The server's own log names it: `Request came in with unrecognized domain / IP '<name>' in header Host;
 * treating as non-local`. It is DNS-rebinding protection, it is keyed on the `Host` header rather than on
 * the peer address, and `allowedNetworks` does not override it.
 *
 * WHAT IT COST BEFORE IT WAS UNDERSTOOD. Two things, and the second is the worse one. It failed the paced
 * direct-play phase, whose consumer reached the server container-to-container by name and got a 401 from
 * ffmpeg. And it produced a completely wrong finding about plex.tv, written into this file, into the
 * data-plane document, into the acceptance plan and into a skip check in the gate that would have made an
 * offline host report SKIPPED for a reason that does not exist.
 *
 * So every URL this gate hands to a container names the server by ADDRESS.
 */
export const PLEX_REJECTS_UNRECOGNISED_HOST_HEADER = true;

/**
 * The gate's own Plex client identity.
 *
 * `platform` IS NOT COSMETIC AND IT IS NOT `Linux`. Measured: `GET /video/:/transcode/universal/start.m3u8`
 * with `X-Plex-Platform=Linux&X-Plex-Device=Linux` answers **400**, and the server log says
 * `Unable to find client profile for device; platform=Linux, ... / TranscodeUniversalRequest: unable to find
 * a matching profile`. The transcode endpoint resolves a client PROFILE from these fields and refuses the
 * request when it cannot. `Chrome` resolves; so does `Windows`; `Generic` resolves too. `Chrome` is used
 * because it is the profile a Plex Web session gets, which is the most ordinary client this server sees.
 *
 * The identifier is a constant so that two runs of the gate present the SAME device to the server — a gate
 * whose whole claim is three consecutive runs must not look like three different clients.
 */
export const PLEX_CLIENT = Object.freeze({
  identifier: 'projection-phase1-plex-gate',
  product: 'Plex Web',
  version: '4.0',
  platform: 'Chrome',
  device: 'Windows',
  deviceName: 'projection-gate',
} as const);

/**
 * The `X-Plex-*` parameters every request carries, as query rather than as headers.
 *
 * WHY QUERY AND NOT HEADERS. Plex accepts either, but it GENERATES the child URLs of the playlists it returns
 * in the shape of the request that asked for them — so the transcode session's identity has to be in the
 * query for the generated segment URLs to belong to the same session. Sending it two ways would put the same
 * facts in two places that could disagree.
 *
 * THERE IS NO CREDENTIAL IN HERE. An unclaimed server needs none (see above), and this gate deliberately
 * authors no `X-Plex-Token` anywhere: `plexHasQueryCredential` exists to catch one arriving from the server
 * rather than to describe anything this process sends.
 */
export function plexClientQuery(): Record<string, string> {
  return {
    'X-Plex-Client-Identifier': PLEX_CLIENT.identifier,
    'X-Plex-Product': PLEX_CLIENT.product,
    'X-Plex-Version': PLEX_CLIENT.version,
    'X-Plex-Platform': PLEX_CLIENT.platform,
    'X-Plex-Device': PLEX_CLIENT.device,
    'X-Plex-Device-Name': PLEX_CLIENT.deviceName,
  };
}

/** JSON rather than Plex's default XML. Measured: every endpoint this gate uses honours it. */
export const PLEX_ACCEPT_JSON = 'application/json';

// ---------------------------------------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------------------------------------

/**
 * The library this gate creates, and why every field of it is what it is.
 *
 * `agent: tv.plex.agents.none` IS THE LOAD-BEARING CHOICE. It is Plex's own "Plex Personal Media" agent, and
 * it performs **no online matching whatsoever**: an item's `guid` stays `tv.plex.agents.none://<id>` and its
 * title comes from the filename. The alternative — `tv.plex.agents.movie`, the default Plex Movie agent —
 * matches every file against plex.tv's metadata service, which would make this gate's item identities depend
 * on a third party's catalogue, make two runs differ for reasons that have nothing to do with projection, and
 * make a scan hang on somebody else's timeout. The scanner still opens every file, still probes it and still
 * has to get real bytes back through the mount; what is off is the part that asks the internet what the file
 * is, which is not a question about a data plane.
 *
 * `scanner: Plex Video Files` is the personal-media scanner that pairs with it. `Plex Movie` — the scanner,
 * not the agent — parses titles and years for matching, which is the thing being avoided.
 *
 * `type: movie` because a Plex library must have a type and this is the one a flat directory of video files
 * belongs to. Nothing in the gate depends on the type beyond that.
 */
export const PLEX_LIBRARY = Object.freeze({
  type: 'movie',
  agent: 'tv.plex.agents.none',
  scanner: 'Plex Video Files',
  language: 'en-US',
} as const);

/**
 * PLEX ANSWERS **400** WHILE IT IS STILL STARTING, AND THE BODY IS THE ONLY THING THAT SAYS SO.
 *
 * Measured: `/identity` answers, `/` answers, `PUT /:/prefs` answers and every preference reads back
 * correctly — and then the very first WRITE, `POST /library/sections`, comes back
 * `400 ... the server is still starting up. Please retry later`. The server accepts reads before it will
 * accept a library creation, so "the server is up" and "the server will create a library" are two different
 * facts and only the first was being checked.
 *
 * WHY THE STATUS CANNOT DECIDE THIS ON ITS OWN, AND WHY THAT MATTERS MORE THAN THE FIX. A retry keyed on
 * `400` would swallow every genuine refusal this endpoint makes — an agent that does not exist, a scanner
 * that does not exist, a location the server cannot see — and turn each of them into a two-minute wait
 * followed by a timeout, with the real reason discarded. Those are exactly the mistakes a gate must fail
 * loudly on, on the first attempt. So the retryable answer is recognised by the SENTENCE PLEX WRITES, and
 * everything else is fatal immediately.
 */
export const PLEX_STARTING_UP_MARKER = 'still starting up';

/**
 * Whether a refusal is Plex saying "not yet", as opposed to Plex saying "no".
 *
 * The status is checked as well as the body, so a 200 whose payload happens to contain the phrase — an
 * item titled after it, say — is not mistaken for a refusal to retry.
 */
export function plexIsStartingUp(status: number, body: string): boolean {
  if (status !== 400 && status !== 503) return false;
  return body.toLowerCase().includes(PLEX_STARTING_UP_MARKER);
}

/** `POST` this to create the library. The location is the projected mount as the server sees it. */
export function plexCreateSectionPath(name: string, mountPath: string): string {
  const query = new URLSearchParams({
    name,
    type: PLEX_LIBRARY.type,
    agent: PLEX_LIBRARY.agent,
    scanner: PLEX_LIBRARY.scanner,
    language: PLEX_LIBRARY.language,
    location: mountPath,
    ...plexClientQuery(),
  });
  return `/library/sections?${query.toString()}`;
}

/**
 * The server preferences this gate forces, and the reason each one would otherwise ruin a measurement.
 *
 * THESE ARE NOT A WEAKENING OF THE READ PATH. Every one of them turns off work that is either (a) an internet
 * lookup, which this gate does not measure and cannot make deterministic, or (b) a background job that reads
 * WHOLE MEDIA FILES on a schedule — which would land inside the amplification window and be attributed to a
 * library scan. Deep media analysis in particular reads an entire file to compute its bitrate profile; a run
 * whose butler window opened mid-gate would blow `MAX_SCAN_BYTE_FRACTION` and the report would say the daemon
 * had downloaded the library, which would be a false accusation against the product.
 *
 * They are asserted after being set, not merely sent, because `PUT /:/prefs` answers 200 for a preference it
 * does not recognise.
 */
export const PLEX_SERVER_PREFS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  // Scanning happens when this gate asks for it, and at no other time. A watcher on a FUSE mount whose
  // namespace changes when a generation is admitted would deliver a storm of change events, and every
  // "a re-scan changed nothing" assertion here is about what an EXPLICIT scan found.
  ['FSEventLibraryUpdatesEnabled', '0'],
  ['FSEventLibraryPartialScanEnabled', '0'],
  ['ScheduledLibraryUpdatesEnabled', '0'],
  ['ButlerTaskRefreshLibraries', '0'],
  // Whole-file reads on a timer. Each of these would put provider bytes into a window this gate attributes
  // to a scan.
  ['ButlerTaskDeepMediaAnalysis', '0'],
  ['ButlerTaskUpgradeMediaAnalysis', '0'],
  ['ButlerTaskRefreshLocalMedia', '0'],
  ['ButlerTaskGenerateMediaIndexFiles', '0'],
  ['GenerateBIFBehavior', 'never'],
  ['GenerateChapterThumbBehavior', 'never'],
  ['LoudnessAnalysisBehavior', 'never'],
  ['GenerateIndexFilesDuringAnalysis', '0'],
  // Internet metadata for items the personal-media agent already declines to match. Off for the same reason
  // the agent is: it is not a question about a data plane.
  ['ButlerTaskRefreshPeriodicMetadata', '0'],
  ['ButlerTaskRefreshEpgGuides', '0'],
  // Nothing about this server is published anywhere, and it reports no crashes to anybody.
  ['PublishServerOnPlexOnlineKey', '0'],
  ['sendCrashReports', '0'],
  ['GdmEnabled', '0'],
  ['DlnaEnabled', '0'],
  // THE TRASH IS EMPTIED AUTOMATICALLY, ON PURPOSE, AND IT IS LEFT AT PLEX'S DEFAULT OF 1 FOR THAT REASON.
  // Every churn assertion in this gate says a scan removed ZERO items. With the trash held, a file that had
  // genuinely vanished would sit in the library as an unavailable item and "zero removed" would be true of a
  // library that had lost its media — a check that cannot fail. With auto-empty on, a removal is a removal.
  ['autoEmptyTrash', '1'],
]);

/** `PUT` this to apply them. */
export function plexPrefsPath(prefs: ReadonlyArray<readonly [string, string]> = PLEX_SERVER_PREFS): string {
  const query = new URLSearchParams(plexClientQuery());
  for (const [key, value] of prefs) query.set(key, value);
  return `/:/prefs?${query.toString()}`;
}

// ---------------------------------------------------------------------------------------------------------
// What a Plex scan costs at the provider, which is NOT what a Jellyfin scan costs
// ---------------------------------------------------------------------------------------------------------

/**
 * WHAT A PLEX SCAN COSTS AT THE PROVIDER — AND WHY THE FIRST TWO ANSWERS HERE WERE BOTH WRONG.
 *
 * MEASURED, AGAINST FIXTURES THAT TURNED OUT TO BE THE WRONG INSTRUMENT:
 *
 *   | scan | provider bytes | remote bytes in the library | ratio |
 *   |---|---|---|---|
 *   | two-entry generation | 17,825,792 | 13,981,407 | **1.28x** |
 *   | ~50-entry corpus | 40,096,953 | 24,111,354 | **1.66x** |
 *
 * THE FIRST WRONG ANSWER was a Plex-specific multiplier of 3.0, chosen to sit above those numbers. A ceiling
 * placed above an observation is a record of the observation with room around it: it would have passed a
 * daemon that read every object three times over.
 *
 * THE SECOND WRONG ANSWER, in the comment this replaces, was to read those ratios as a product defect —
 * "Plex reads the whole object, so the fraction argument is contradicted". It is not, because **neither
 * fixture was large enough for the argument to be about them**. The daemon serves a 4 MiB demand block for a
 * one-byte read, and Plex opens each new item twice — its own log shows `Plex Media Scanner --analyze`
 * launched per item with the scheduled task off — touching about three blocks per open. Identifying ONE
 * object therefore has a BUDGET of `2 x min(3 x 4 MiB, size)` — topping out at 24 MiB, but clamping to twice
 * the object below 12 MiB. Against an 8.6 MB soak source and a 14.0 MB anchor that ceiling already permits a
 * whole-object read, so **satisfying it would prove nothing about the fraction** — which is a limit of the
 * instrument, not a lower bound on what the daemon reads.
 *
 * SO THE HISTORICAL RATIOS ARE KEPT AND RELABELLED: 1.28x and 1.66x are observations of what was read on
 * undersized fixtures. They are not evidence of waste and they are not evidence for the claim.
 *
 * WHAT IS ASSERTED NOW. A ceiling derived from that geometry rather than from any fixture's size; a floor
 * derived per object so no entry can be paid for by another; and the product's actual claim, moved to the
 * one place it can be tested — a 96 MiB fixture, four times the fixed window, held to the SHARED
 * `MAX_SCAN_BYTE_FRACTION`. **That last assertion has not yet been observed to hold: no gate run has passed.**
 *
 * AND ONE THING NEITHER ANSWER TOUCHED, WHICH REMAINS THE STRONGEST AMPLIFICATION CLAIM PLEX SUPPORTS: a
 * re-scan of an unchanged generation costs the provider zero ranged GETs and zero bytes.
 */
/**
 * THE GEOMETRY EVERY BUDGET BELOW IS DERIVED FROM. Not one of these numbers is chosen; each is read off the
 * daemon or off Plex's measured behaviour.
 */
export const PLEX_READ_GEOMETRY = Object.freeze({
  /** `readpath.DefaultConfig().ChunkBytes` — the daemon's demand block. A read of one byte costs one. */
  CHUNK_BYTES: 4 * 1024 * 1024,
  /** `manifest.ProbeWindowBytes` — one scan window, of which the contract's plan has three. */
  PROBE_WINDOW_BYTES: 1_048_576,
  /** `manifest.SingleProbeBelowByte` — below this an object's whole probe plan is one window over all of it. */
  SINGLE_PROBE_BELOW_BYTES: 3 * 1_048_576,
  /**
   * How many times Plex opens a NEW item during a scan.
   *
   * TWO, AND THE SECOND ONE IS IN THE SERVER'S OWN LOG: Plex launches `Plex Media Scanner --analyze` for
   * every new item, in addition to the scan that found it, even with the scheduled deep-analysis task off.
   */
  OPENS_PER_NEW_ITEM: 2,
  /**
   * How many distinct demand blocks one open can touch: a container header, the `moov` wherever it is, and
   * one interior probe. Derived, then checked against measurement: the 13,981,407-byte anchor cost
   * 17,825,792 bytes over two opens — 2.1 blocks per open, inside this.
   */
  DEMAND_BLOCKS_PER_OPEN: 3,
} as const);

/**
 * THE CEILING ON WHAT A PLEX SCAN MAY COST AT THE PROVIDER, PER OBJECT, FROM BLOCK GEOMETRY.
 *
 * WHY THIS REPLACED A MULTIPLIER, AND WHY THE MULTIPLIER WAS WRONG. The first attempt at this gate met three
 * failing byte budgets and answered them with `MAX_SCAN_BYTE_MULTIPLIER = 3.0` — a number above 1.0 chosen to
 * sit above what had been measured. That is not a budget, it is a record of an observation with room around
 * it: it would have passed a daemon that read every object three times over, and it quietly retired the
 * product's central claim rather than testing it.
 *
 * THE ARITHMETIC THE MULTIPLIER WAS HIDING. The daemon serves a 4 MiB demand block for a one-byte read. Plex
 * opens a new item twice and touches about three blocks per open. So the CEILING on scanning ONE object is
 * `opens x min(blocks x chunk, size)` = `2 x min(3 x 4 MiB, size)` — saturating at 24 MiB for an object of
 * 12 MiB or more, and equal to twice the object below that. It is the same shape whether the object is 40 KB
 * or 400 MB.
 *
 * WHAT THAT MEANS FOR THE SMALL FIXTURES — AND WHAT IT DOES NOT. The soak source is 8.6 MB and the anchor
 * 14.0 MB, so at those sizes this ceiling permits **at least a whole-object read**. That is a statement
 * about the CEILING, not about the daemon: passing it would not prove a below-one fraction, and it is not a
 * lower bound, so it does not mean a below-one read is unreachable or that no correct implementation could
 * achieve one. A ceiling says "not more than"; inferring "not less than" from it is a mistake this comment
 * made once and should not make again.
 *
 * The measured 1.28x and 1.66x are separately just observations of what was read on those fixtures. They do
 * not prove the fraction claim either. **So the claim is tested where an actual-byte measurement has useful
 * margin: against an object several times larger than the point at which the ceiling saturates.** See
 * `PLEX_LARGE_FIXTURE`.
 *
 * THE FLOOR IS A DIFFERENT NUMBER AND LIVES IN THE CLI: one probe window per object, or the object itself
 * when it is smaller than a window. A ceiling asks "did this cost too much"; a floor asks "did it happen at
 * all", and a scan that fetched almost nothing would satisfy any ceiling while meaning the scanner never
 * opened the entries.
 */
export function plexScanByteCeiling(objectSizes: readonly number[]): number {
  const fixed = PLEX_READ_GEOMETRY.DEMAND_BLOCKS_PER_OPEN * PLEX_READ_GEOMETRY.CHUNK_BYTES;
  return objectSizes.reduce(
    (total, size) => total + PLEX_READ_GEOMETRY.OPENS_PER_NEW_ITEM * Math.min(fixed, Math.max(0, size)),
    0,
  );
}

/**
 * THE OBJECT THE FRACTION CLAIM IS ASSERTED AGAINST, and why it has to be this big.
 *
 * The ceiling `opens x min(blocks x chunk, size)` saturates at 24 MiB once the object reaches 12 MiB, and
 * below that it is simply twice the object — so on a small fixture the ceiling already permits a whole-object
 * read and CANNOT ITSELF establish a sub-one fraction. (It also cannot rule one out: a ceiling is not a lower
 * bound.) At 96 MiB the saturated 24 MiB is 0.25 of the object, so an actual-byte measurement there has real
 * margin, and that is where the product's claim — that identifying an object does not require downloading it
 * — is tested. The size is not a round number picked for comfort: it is the smallest multiple of the
 * saturated ceiling at which a sub-0.5 fraction sits clear of the boundary.
 */
export const PLEX_LARGE_FIXTURE = Object.freeze({
  /** 96 MiB: four times the 24 MiB the per-object budget saturates at, so the expected fraction is ~0.25. */
  MIN_BYTES: 96 * 1024 * 1024,
  /**
   * The fraction of ITS OWN LENGTH a scan of the large object may read.
   *
   * THIS IS THE SHARED CONSTANT, DELIBERATELY. `MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION` is what carries
   * the product's argument, and the point of the large fixture is to put Plex under that same number rather
   * than under one of its own.
   */
  MAX_SCAN_BYTE_FRACTION: MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION,
} as const);

/**
 * THE CEILING ON WHAT TEN SEEKS MAY COST AT THE PROVIDER, from the same geometry.
 *
 * A seek on Plex restarts the encoder at the new position, and a restart is an open: up to
 * `DEMAND_BLOCKS_PER_OPEN` demand blocks, plus the session's own setup reads. That is `seeks x 3 x 4 MiB`
 * plus a fixed allowance, and it does **not** scale with the object's size — which is why the previous
 * spelling, `1.2 x object x 10`, was both loose and unstable: on a small fixture it was a hair above the
 * arithmetic floor, and on a large one it would have been meaningless. Measured: 54,485,469 bytes for ten
 * seeks, against a derived ceiling of 10 x 12 MiB + 3 MiB = 128,974,848.
 */
export function plexSeekByteCeiling(seekCount: number): number {
  const perSeek = PLEX_READ_GEOMETRY.DEMAND_BLOCKS_PER_OPEN * PLEX_READ_GEOMETRY.CHUNK_BYTES;
  const sessionSetup = 3 * PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES;
  return seekCount * perSeek + sessionSetup;
}

// ---------------------------------------------------------------------------------------------------------
// "An ordinary file", as Plex is able to say it
// ---------------------------------------------------------------------------------------------------------

/**
 * What Plex says about one part of one item. Only the fields a corpus assertion is entitled to look at.
 *
 * `accessible` AND `exists` ARE THE STRONG ONES, AND THEY ONLY APPEAR IF YOU ASK. `GET /library/metadata/{k}`
 * omits them; `GET ...?checkFiles=1` makes the server **stat the file, now, through the mount** and report
 * the answer. That is the closest thing Plex has to Jellyfin's `Protocol=File, LocationType=FileSystem,
 * IsRemote=false` quartet — and it is better evidence, because it is a live filesystem operation rather than
 * a field the scanner cached at import time. A projected entry that had become unreadable would still be
 * listed with its old size; `accessible` is what refuses to go on saying so.
 */
export interface PlexPartObservation {
  /** The path Plex holds for this part. The gate matches an item to what it published by this basename. */
  readonly file: string;
  readonly sizeBytes: number;
  readonly container: string;
  /** From `checkFiles=1`. Absent means the gate did not ask, which is not the same as false. */
  readonly accessible?: boolean;
  readonly exists?: boolean;
}

/**
 * Whether Plex is describing an ordinary, readable file on a filesystem.
 *
 * WHY THE ABSENT CASE IS A FAILURE RATHER THAN A PASS. `accessible === undefined` means the listing was
 * fetched without `checkFiles=1`, so the server never looked. A predicate that treated "not checked" as
 * "fine" would silently downgrade every corpus assertion the first time somebody dropped the parameter, and
 * the report would go on saying fifty identities were confirmed present as ordinary files.
 */
export function plexPartIsOrdinaryFile(part: PlexPartObservation): boolean {
  if (part.accessible !== true || part.exists !== true) return false;
  if (part.container === '') return false;
  if (part.sizeBytes <= 0) return false;
  if (part.file === '' || part.file.endsWith('.strm')) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------------------------------------

/**
 * DIRECT PLAY on Plex is a `GET` of the part's own key, and the server hands back the file unmodified.
 *
 * There is no `static=true` to ask for and no decision to make: `/library/parts/{id}/{updatedAt}/file.{ext}`
 * is the file. Measured: it answers `200` with the exact published length and `Accept-Ranges: bytes`, and a
 * `Range` request answers `206` with an exact `Content-Range`.
 *
 * THE PART KEY COMES FROM THE SERVER, NOT FROM THIS FUNCTION. It embeds the part id and the part's
 * `updatedAt`, so a key assembled here would go stale the moment the server re-imported anything. The gate
 * reads the key out of the item listing and passes it in — and strips any credential the server put in it
 * before following it, which `plexStripQueryCredentials` does and the gate asserts it never had to.
 */
export function plexDirectPlayPath(partKey: string): string {
  const query = new URLSearchParams(plexClientQuery());
  return `${partKey}?${query.toString()}`;
}

// ---------------------------------------------------------------------------------------------------------
// Forced transcode, and the seek that is built out of it
// ---------------------------------------------------------------------------------------------------------

/** Plex's HLS segment container, which is what the decoder is handed. */
export const PLEX_SEGMENT_CONTAINER = 'mpegts';

/**
 * A FORCED-TRANSCODE request against Plex's universal transcoder.
 *
 * `directPlay=0&directStream=0` IS A REQUEST FIELD AND IS THEREFORE NOT THE EVIDENCE. It is how a client asks
 * Plex to re-encode rather than remux, and a gate that stopped there would have proved that a parameter can
 * be sent. What proves a transcode ran is the same thing that proves it in the Jellyfin gate: the source is
 * encoded as `mpeg4`, `h264` is what comes out, and the segments are handed to a decoder that is not Plex.
 *
 * `offset` IS HOW A SEEK IS PERFORMED, AND THIS COMMENT USED TO SAY THE OPPOSITE. It said offset was always
 * zero and the seek gate did not use it, on the strength of a true observation with a false conclusion: the
 * variant playlist for `offset=300` does list the WHOLE file — 43 segments and 344 seconds of `#EXTINF` —
 * exactly as `offset=0` does, and a session started at an offset does answer segments below it with an
 * 188-byte body. What does not follow is that offset is useless for seeking. It is the ONLY thing that works:
 * re-issuing `start.m3u8` at the wanted offset restarts the encoder there, and the segment at that position
 * then answers in about 300 ms. Asking for an out-of-order segment without it wedges the session after a
 * handful of requests. See `PLEX_SEEK_IS_AN_OFFSET_RESTART` for the measurements on both sides.
 *
 * `session` IS THE JOB'S IDENTITY. Every child URL and every `/transcode/sessions` row is keyed on it, so the
 * gate mints one per phase and can therefore tell its own encoder job from anything else on the server.
 */
export function plexTranscodeStartPath(metadataKey: string, session: string, offsetSeconds = 0): string {
  const query = new URLSearchParams({
    path: metadataKey,
    mediaIndex: '0',
    partIndex: '0',
    protocol: 'hls',
    fastSeek: '1',
    directPlay: '0',
    directStream: '0',
    subtitles: 'none',
    audioBoost: '100',
    location: 'lan',
    offset: String(offsetSeconds),
    session,
    ...plexClientQuery(),
  });
  return `/video/:/transcode/universal/start.m3u8?${query.toString()}`;
}

/**
 * HOW A SEEK IS ACTUALLY PERFORMED AGAINST PLEX, MEASURED THREE TIMES BECAUSE THE FIRST ANSWER WAS WRONG.
 *
 * **A seek is a new `start.m3u8` at the wanted `offset`, on the same session, followed by the segment at
 * that position.** That is what a Plex client does: it TELLS the server where to restart, rather than
 * letting the server infer it from a segment request that arrives out of order.
 *
 * WHAT THIS REPLACES, AND WHY IT IS NOT A CONVENIENCE. The Jellyfin gate seeks by holding one playlist and
 * requesting the segment it wants, wherever that is; Jellyfin answers every one in well under a second. The
 * Plex driver was written the same way, and against a real Plex it **hangs**. Measured against a purely
 * LOCAL file — no FUSE, no provider, nothing of this product involved — with one session and out-of-order
 * segment GETs in the gate's own seek order:
 *
 *     seg 00000 212ms | 00002 112ms | 00039 191ms | 00008  57ms | 00026 192ms | 00000  64ms
 *     seg 00017 196ms | 00041 **45073ms** | 00006 109ms | 00033 **timed out at 45s** | 00014 191ms
 *
 * It works for the first several and then wedges, and it wedges with no media server, no mount and no
 * provider in the picture. Two full gate runs were lost to it: one reported a 20.33 s seek, the next timed
 * out on segment 00017 after 30 s. Raising the timeout would have turned a broken mechanism into a slow one
 * and left the ten-second contract meaningless.
 *
 * The same ten positions through the offset mechanism, on the same server and the same file:
 *
 *     296ms  312ms  268ms  322ms  316ms  316ms  329ms  354ms  311ms  270ms
 *
 * ...and the segments returned are correct: ten distinct bodies, every one decoding as `h264`, every decoded
 * start timestamp exactly **+10.0 s** from the position the server's own playlist gives that segment (spread
 * 0.167 s across all ten). So the mechanism changed and not one assertion was weakened — the ten-second
 * ceiling, the distinctness, the position agreement and the constant-offset temporal check all still hold,
 * and they hold with two orders of magnitude of headroom instead of failing.
 */
export const PLEX_SEEK_IS_AN_OFFSET_RESTART = true;

/**
 * The variant playlist for a session.
 *
 * IT MUST BE FETCHED BEFORE ANY SEGMENT, AND THAT IS A MEASUREMENT RATHER THAN POLITENESS. Requesting
 * `.../session/{s}/base/00002.ts` without having fetched `.../session/{s}/base/index.m3u8` first answers
 * **404**, every time, for every index — the session's segment namespace does not exist until the variant
 * playlist has been generated. Ten seeks were 404ing for exactly this reason before the playlist fetch was
 * put in front of them.
 */
export function plexVariantPlaylistPath(session: string): string {
  return `/video/:/transcode/universal/session/${session}/base/index.m3u8`;
}

/** One segment of a session, by index. Plex names them `%05d.ts`. */
export function plexSegmentPath(session: string, index: number): string {
  return `/video/:/transcode/universal/session/${session}/base/${String(index).padStart(5, '0')}.ts`;
}

/** Keeps a session alive. A session nobody pings is reaped and its segments start answering 404. */
export function plexTranscodePingPath(session: string): string {
  const query = new URLSearchParams({ session, ...plexClientQuery() });
  return `/video/:/transcode/universal/ping?${query.toString()}`;
}

/** Tears the encoder job down. Called on the way out of every phase that started one. */
export function plexTranscodeStopPath(session: string): string {
  const query = new URLSearchParams({ session, ...plexClientQuery() });
  return `/video/:/transcode/universal/stop?${query.toString()}`;
}

/** One entry of a variant playlist: the segment reference, and the duration the SERVER stated for it. */
export interface PlexPlaylistEntry {
  readonly index: number;
  readonly ref: string;
  readonly seconds: number;
  /** Where in the media the server's own playlist says this segment starts. Cumulative over `#EXTINF`. */
  readonly startSeconds: number;
}

/**
 * Parse a Plex variant playlist into the server's own account of where each segment sits in the media.
 *
 * THE START POSITIONS ARE THE SERVER'S ARITHMETIC, NOT THIS GATE'S GUESS, and that distinction is the whole
 * reason this function exists rather than `index * 8`. Eight seconds is what the pinned server happens to
 * use; a gate that hard-coded it would be asserting a property of one build's segmenter, and would silently
 * start measuring the wrong positions the day it changed. `#EXTINF` is the server stating a duration, and the
 * running sum of them is the server stating a position. G9 asks for "server presentation time measured rather
 * than assumed", and this is where the measuring happens.
 */
export function parsePlexVariantPlaylist(playlist: string): PlexPlaylistEntry[] {
  const entries: PlexPlaylistEntry[] = [];
  let pending: number | undefined;
  let cumulative = 0;
  for (const raw of playlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0] ?? '');
      pending = Number.isFinite(value) ? value : undefined;
      continue;
    }
    if (line.startsWith('#')) continue;
    // A media line with no `#EXTINF` in front of it is a malformed playlist, and guessing a duration for it
    // would corrupt every start position after it. It is dropped and the caller's count assertion catches it.
    if (pending === undefined) continue;
    entries.push({ index: entries.length, ref: line, seconds: pending, startSeconds: cumulative });
    cumulative += pending;
    pending = undefined;
  }
  return entries;
}

/**
 * Which segment to ask for in order to seek to a position, and what the server says that segment's start is.
 *
 * IT PICKS THE SEGMENT THE POSITION FALLS INSIDE, not the nearest boundary. A player seeking to 316 s plays
 * the segment that CONTAINS 316 s; rounding to the nearer boundary would sometimes ask for the segment after
 * the one the position is in, which is a different position from the one the gate then claims to have sought
 * to.
 */
export function plexSegmentPlanFor(
  entries: readonly PlexPlaylistEntry[], positionSeconds: number,
): PlexPlaylistEntry | undefined {
  if (entries.length === 0) return undefined;
  const containing = entries.find((entry) =>
    positionSeconds >= entry.startSeconds && positionSeconds < entry.startSeconds + entry.seconds);
  if (containing !== undefined) return containing;
  // Past the end of the playlist: the last segment is the closest honest answer, and the caller's position
  // error ceiling is what decides whether that is close enough.
  return positionSeconds < 0 ? entries[0] : entries[entries.length - 1];
}

/**
 * How far the position the server serves may sit from the position asked for, DERIVED FROM THE PLAYLIST.
 *
 * `MEDIA_SERVER_SOAK.MAX_SEEK_POSITION_ERROR_SECONDS` is four seconds, and it is right for Jellyfin, whose
 * segments are three. Plex's are eight. Reusing four would fail a perfectly correct Plex seek roughly half
 * the time, and raising the shared constant to eight would quietly slacken the Jellyfin gate by five seconds
 * — a gate weakened to make a different gate pass, which is the worst possible reason.
 *
 * So the ceiling is one SEGMENT, as the server's own playlist declares it, plus a second of slack. A seek
 * lands on a segment boundary; that is a property of HLS, not a concession. What it still refuses is a server
 * that answered from somewhere else entirely.
 */
export function plexSeekPositionErrorCeilingSeconds(entries: readonly PlexPlaylistEntry[]): number {
  const longest = entries.reduce((max, entry) => Math.max(max, entry.seconds), 0);
  return (longest > 0 ? longest : MEDIA_SERVER_SOAK.MAX_SEEK_POSITION_ERROR_SECONDS) + 1;
}

// ---------------------------------------------------------------------------------------------------------
// Credentials in generated URLs
// ---------------------------------------------------------------------------------------------------------

/**
 * The query parameters that carry a live credential on Plex's API.
 *
 * This gate authors none of them: an unclaimed server needs no token and the gate never mints one. The list
 * exists because the gate FOLLOWS SERVER-GENERATED URLS — the variant playlist's segment references, the part
 * key out of the item listing — and Plex generates child URLs in the shape of the request that asked for
 * them. If a future version, or a claimed server, started propagating `X-Plex-Token` into a playlist body,
 * following it verbatim would put a live credential into this process's request path and from there into any
 * diagnostic that prints one.
 */
const PLEX_CREDENTIAL_QUERY_PARAMS = ['x-plex-token', 'x-plex-session-identifier'] as const;

/** Whether a path the SERVER generated has a credential in its query. */
export function plexHasQueryCredential(pathAndQuery: string): boolean {
  const query = pathAndQuery.split('?')[1];
  if (query === undefined) return false;
  return query.split('&').some((pair) => {
    const name = decodeURIComponent(pair.split('=')[0] ?? '').toLowerCase();
    return (PLEX_CREDENTIAL_QUERY_PARAMS as readonly string[]).includes(name);
  });
}

/** The same path with any credential parameter removed. Defence in depth; the gate asserts it had none. */
export function plexStripQueryCredentials(pathAndQuery: string): string {
  const [path, query] = pathAndQuery.split('?');
  if (query === undefined) return pathAndQuery;
  const kept = query.split('&').filter((pair) => {
    const name = decodeURIComponent(pair.split('=')[0] ?? '').toLowerCase();
    return !(PLEX_CREDENTIAL_QUERY_PARAMS as readonly string[]).includes(name);
  });
  return kept.length === 0 ? (path as string) : `${path}?${kept.join('&')}`;
}

// ---------------------------------------------------------------------------------------------------------
// The scan barrier
// ---------------------------------------------------------------------------------------------------------

/**
 * The activity types that mean Plex is still writing to a library.
 *
 * `butler` IS NOT ONE OF THEM AND THAT IS THE WHOLE POINT OF THIS BEING A LIST. Measured: `/activities`
 * carries a permanent `type="butler" progress="100"` row on an idle server. A barrier that waited for
 * `/activities` to be EMPTY would wait forever, and the obvious repair — waiting for it to stop shrinking —
 * would be a timer wearing a predicate's clothes.
 */
const PLEX_LIBRARY_ACTIVITY_PREFIXES = ['library.', 'media.generate.', 'provider.subscriptions.'] as const;

export function plexActivityIsLibraryWork(type: string | undefined): boolean {
  if (type === undefined || type === '') return false;
  return PLEX_LIBRARY_ACTIVITY_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/** One observation of the library's scan state. Everything is optional; a poll may fail to read a field. */
export interface PlexScanSample {
  /** The section's own `refreshing` attribute. Plex's in-flight flag for a scan. */
  readonly refreshing?: boolean;
  /** The section's `scannedAt`, in epoch seconds. Plex's record of the last COMPLETED scan. */
  readonly scannedAt?: number;
  /** The `type` of every row currently in `/activities`. */
  readonly activities?: readonly string[];
}

export type PlexScanPhase = 'not-started' | 'running' | 'indeterminate' | 'complete';

/**
 * Deciding when a Plex library scan has ACTUALLY started and ACTUALLY finished.
 *
 * THE TRAP THIS EXISTS FOR IS SPECIFIC TO PLEX AND IT WAS MEASURED, NOT REASONED ABOUT. Polling a fifty-entry
 * scan once every two seconds:
 *
 *     t=0   refreshing=1  activities=[library.update.section, butler]
 *     t=2   refreshing=1  activities=[library.update.section, library.update.item.metadata x3, butler]
 *     t=6   refreshing=0  activities=[library.update.item.metadata x3, butler]      <-- items still moving
 *     t=34  refreshing=0  activities=[butler]                                        <-- actually settled
 *
 * **`refreshing` goes false roughly twenty-eight seconds before the library stops changing.** A barrier that
 * watched only that flag — which is the obvious barrier, and is what `refreshing` looks like it is for —
 * would return while Plex was still writing item metadata, and every assertion made afterwards would be made
 * against a library mid-write. The failure would be intermittent, would look like flakiness, and the repair
 * somebody reaches for when a gate is flaky is a sleep.
 *
 * So `complete` requires all three of: an execution having demonstrably happened, `refreshing` false, and NO
 * library-scoped activity outstanding.
 *
 * THE FAST-COMPLETE CASE IS WHY `scannedAt` IS THE BASELINE. A scan of a handful of entries can start and
 * finish between two polls, so requiring `refreshing` to be OBSERVED true would hang forever on a fast
 * server. `scannedAt` moving past the baseline proves an execution happened whether or not anybody saw it —
 * and it can never be satisfied by a stale reading, because the baseline is that same field read immediately
 * before the scan was triggered.
 *
 * IT IS A PURE STATE MACHINE OVER SAMPLES so the cases that are awkward to produce against a real server —
 * the fast complete, the settled-flag-but-busy-activities window, the unreadable poll — can be scripted
 * offline and required to behave.
 */
export class PlexScanBarrier {
  private executionObserved = false;

  private inFlightObserved = false;

  private finished = false;

  constructor(private readonly baselineScannedAt: number | undefined) {}

  /** The phase implied by one sample. Monotonic: neither `running` nor `complete` is ever forgotten. */
  observe(sample: PlexScanSample | undefined): PlexScanPhase {
    if (this.finished) return 'complete';
    if (sample === undefined) {
      // A POLL THAT FAILED IS NOT AN OBSERVATION. It says nothing about the scan, so it advances nothing and
      // claims nothing; the caller's deadline is what stops an unreadable server from being waited on forever.
      if (this.inFlightObserved) return 'running';
      return this.executionObserved ? 'indeterminate' : 'not-started';
    }

    const busyActivities = (sample.activities ?? []).some(plexActivityIsLibraryWork);
    const scannedSinceBaseline = PlexScanBarrier.isAfter(sample.scannedAt, this.baselineScannedAt);

    // POSITIVE, PRESENT-TENSE EVIDENCE OF MOTION. Either the section says it is refreshing, or a library
    // activity is outstanding. Both are the server describing work it is doing right now.
    if (sample.refreshing === true || busyActivities) {
      this.executionObserved = true;
      this.inFlightObserved = true;
      return 'running';
    }

    // SETTLED ON EVERY AXIS, AND EITHER A NEW `scannedAt` OR A SCAN THIS OBSERVER WATCHED RUN.
    //
    // WHY THE SECOND DISJUNCT EXISTS. Requiring `scannedSinceBaseline` alone was a hang waiting to happen:
    // a scan that this observer SAW running and then saw go quiet is finished whatever the section's
    // timestamp says, and Plex does not promise to move `scannedAt` for a refresh that changed nothing. The
    // barrier would have waited out its full deadline on a library that had demonstrably settled, and the
    // failure would have read as a slow scanner rather than as a barrier that could not recognise the end.
    //
    // AND THE STALE-QUIET TRAP IS STILL SHUT. A server that is quiet, has never been seen running, and
    // carries the same `scannedAt` we baselined on satisfies neither disjunct: it falls through to
    // `not-started`, which is exactly what it is.
    if (sample.refreshing === false && !busyActivities && (scannedSinceBaseline || this.inFlightObserved)) {
      this.executionObserved = true;
      this.finished = true;
      return 'complete';
    }

    // A new scan has been recorded but the sample could not say whether the section is refreshing. Not
    // finished, not demonstrably under way. The wait continues and NOTHING is claimed from it.
    if (scannedSinceBaseline) {
      this.executionObserved = true;
      return 'indeterminate';
    }
    if (this.inFlightObserved) return 'running';
    return this.executionObserved ? 'indeterminate' : 'not-started';
  }

  /** Whether a scan has been observed to have happened, in flight or between polls. */
  get executionSeen(): boolean { return this.executionObserved; }

  /**
   * Whether the scanner was seen ACTUALLY RUNNING by this observer.
   *
   * This is the only property a "while a scan was running" claim may rest on. A scan that started and
   * finished between two polls sets `executionSeen` and MUST NOT set this.
   */
  get observedInFlight(): boolean { return this.inFlightObserved; }

  private static isAfter(current: number | undefined, baseline: number | undefined): boolean {
    if (current === undefined || !Number.isFinite(current)) return false;
    if (baseline === undefined || !Number.isFinite(baseline)) return true;
    return current > baseline;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The encoder, which on Plex can actually be measured
// ---------------------------------------------------------------------------------------------------------

/**
 * PLEX HAS NO CLIENT-WRITABLE PLAY-METHOD FIELD, AND THIS CONSTANT IS WHERE THAT IS RECORDED.
 *
 * The Jellyfin gate discovered, by negative control against a live server with a genuine transcode serving
 * the segments, that a client reporting `PlayMethod: DirectPlay` is read back as `DirectPlay` — so Jellyfin's
 * `PlayState.PlayMethod` is authored by whoever last spoke and cannot carry an assertion about the server.
 *
 * Plex's equivalent surface is `/transcode/sessions`, whose rows carry `videoDecision`, `sourceVideoCodec`,
 * `videoCodec`, `throttled`, `complete`, `progress` and `maxOffsetAvailable`. There is no client endpoint
 * that writes any of them: Plex's client-facing progress API is `/:/timeline`, whose parameters are position,
 * state and item — there is no play-method field for a client to lie in, and `/transcode/sessions` describes
 * a process the server started, not a claim the client made.
 *
 * THAT DOES NOT MAKE IT THE EVIDENCE. "The field is not forgeable by the client" is a much weaker statement
 * than "the field is a measurement of the encoder", and this gate rests its transcode claim on the same place
 * the Jellyfin gate does: a source encoded as mpeg4, and every consumed segment decoded as h264 by a decoder
 * that is not Plex. What `/transcode/sessions` is used for here is the ENCODER-LIFETIME question, which
 * decoded output cannot answer at all — and which is asserted only to the extent
 * `analysePlexEncoderLiveness` can support from advancing output offsets.
 */
export const PLEX_HAS_NO_CLIENT_WRITABLE_PLAY_METHOD = true;

/** One sample of Plex's own account of this gate's transcode job. Every field is the server's. */
export interface PlexEncoderSample {
  /** Milliseconds from the start of the soak window. */
  readonly wallMs: number;
  /** Whether a session with this gate's key existed at all. Everything below is meaningless without it. */
  readonly present: boolean;
  /** The server says the encoder job has finished producing. */
  readonly complete?: boolean;
  /** The server says the encoder is being held back because the client is far enough ahead. */
  readonly throttled?: boolean;
  /** How many seconds of output the encoder has produced. The liveness signal. */
  readonly maxOffsetAvailable?: number;
  readonly progress?: number;
  readonly speed?: number;
  readonly videoDecision?: string;
  readonly sourceVideoCodec?: string;
  readonly videoCodec?: string;
}

export interface PlexEncoderLiveness {
  readonly samples: number;
  readonly presentSamples: number;
  /** Samples in which a session existed and the server had not marked it complete. */
  readonly liveSamples: number;
  /** Samples in which the server said the encoder was being throttled by the client's pace. */
  readonly throttledSamples: number;
  /** How many times `maxOffsetAvailable` was seen to INCREASE. Each one is fresh encoder output. */
  readonly advances: number;
  /** Wall seconds between the first and the last of those increases. */
  readonly workingSpanSeconds: number;
  /** Media seconds of output the encoder produced, from its first reported offset to its last. */
  readonly producedSpanSeconds: number;
  /** Samples in which the server's own decision for this job was a video transcode. */
  readonly transcodeDecisionSamples: number;
  /** Samples in which the server named the SOURCE as the codec the gate encoded it in. */
  readonly sourceCodecSamples: number;
  /** Samples in which the server named the OUTPUT as the codec the gate demanded. */
  readonly targetCodecSamples: number;
}

/**
 * What Plex's own transcode session did across the five-minute window.
 *
 * WHY THIS EXISTS WHEN THE JELLYFIN GATE DELIBERATELY HAS NO EQUIVALENT ASSERTION. Measured against the
 * pinned Jellyfin, the encoder finishes a 340-second, 320x240, 150 kbit/s source in about 1.6 seconds and
 * exits, so a five-minute encoder-lifetime claim there would fail every correct run and the Jellyfin gate
 * records the number instead. Measured against the pinned Plex, on the same class of source, over a
 * ninety-second paced probe:
 *
 *     t=0s   throttled=false complete=false maxOffsetAvailable=16
 *     t=8s   throttled=true  complete=false maxOffsetAvailable=104
 *     t=50s  throttled=false complete=false maxOffsetAvailable=112
 *     t=58s  throttled=true  complete=false maxOffsetAvailable=152
 *     t=91s  throttled=true  complete=false maxOffsetAvailable=160
 *
 * Plex holds the encoder to a bounded lead over the client — `TranscoderThrottleBuffer` defaults to sixty
 * seconds — so the job is still alive, still incomplete, and still producing new output most of the way
 * through a paced window. That is a genuinely different server behaviour, and copying Jellyfin's non-claim
 * across would have understated what can honestly be shown here.
 *
 * WHAT IS ASSERTED AND WHAT IS MERELY RETURNED. The gate asserts `advances`, `workingSpanSeconds`,
 * `throttledSamples` and `presentSamples`, each against a floor well below what was measured, because a floor
 * that sits at the observed value is a floor that fails the first time a machine is busy. `progress`, `speed`
 * and the codec-agreement counts are returned and reported and asserted on by nothing — they are the server's
 * bookkeeping, and this gate's transcode claim does not rest on a server's bookkeeping.
 */
export function analysePlexEncoderLiveness(samples: readonly PlexEncoderSample[]): PlexEncoderLiveness {
  const ordered = [...samples].sort((a, b) => a.wallMs - b.wallMs);
  const present = ordered.filter((sample) => sample.present);

  let advances = 0;
  let firstAdvanceMs: number | undefined;
  let lastAdvanceMs: number | undefined;
  let previousOffset: number | undefined;
  let lowestOffset: number | undefined;
  let highestOffset: number | undefined;
  for (const sample of present) {
    const offset = sample.maxOffsetAvailable;
    if (offset === undefined || !Number.isFinite(offset)) continue;
    lowestOffset = lowestOffset === undefined ? offset : Math.min(lowestOffset, offset);
    highestOffset = highestOffset === undefined ? offset : Math.max(highestOffset, offset);
    if (previousOffset !== undefined && offset > previousOffset) {
      advances += 1;
      if (firstAdvanceMs === undefined) firstAdvanceMs = sample.wallMs;
      lastAdvanceMs = sample.wallMs;
    }
    previousOffset = offset;
  }

  return {
    samples: ordered.length,
    presentSamples: present.length,
    liveSamples: present.filter((sample) => sample.complete !== true).length,
    throttledSamples: present.filter((sample) => sample.throttled === true).length,
    advances,
    workingSpanSeconds: (firstAdvanceMs === undefined || lastAdvanceMs === undefined)
      ? 0 : (lastAdvanceMs - firstAdvanceMs) / 1_000,
    producedSpanSeconds: (lowestOffset === undefined || highestOffset === undefined)
      ? 0 : highestOffset - lowestOffset,
    transcodeDecisionSamples: present.filter((sample) => sample.videoDecision === 'transcode').length,
    sourceCodecSamples: present.filter((sample) =>
      sample.sourceVideoCodec === TRANSCODE_SOURCE_VIDEO_CODEC).length,
    targetCodecSamples: present.filter((sample) => sample.videoCodec === TRANSCODE_TARGET_VIDEO_CODEC).length,
  };
}

/**
 * The floors the encoder-liveness assertion holds, and why each sits where it does.
 *
 * EVERY ONE OF THEM IS WELL BELOW WHAT WAS MEASURED. The probe above produced four advances in ninety seconds
 * with a sixty-seven-second working span; scaled to a three-hundred-second window that is roughly a dozen
 * advances across two hundred and fifty seconds. The floors are set at eight and one hundred and twenty. A
 * threshold pinned to the observed value is a threshold that fails on a loaded machine, and a gate that fails
 * when nothing is wrong gets disabled and then gets deleted.
 */
export const PLEX_ENCODER_FLOORS = Object.freeze({
  /** Distinct moments at which the encoder was seen to have produced NEW output. */
  MIN_OFFSET_ADVANCES: 8,
  /** Wall seconds between the first and last of those moments. */
  MIN_WORKING_SPAN_SECONDS: 120,
  /**
   * Samples in which the server said the encoder was throttled.
   *
   * ONE IS ENOUGH AND MORE WOULD BE WRONG. What this refuses is an encoder that raced to the end of the file
   * in a burst and then sat idle while the client consumed a finished directory — which is exactly what
   * Jellyfin does, and which would produce zero throttled samples. It is not a claim about how often Plex
   * throttles, which depends on the machine.
   */
  MIN_THROTTLED_SAMPLES: 1,
} as const);
