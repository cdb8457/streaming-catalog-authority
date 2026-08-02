// Projection Phase 1 — what is true of EMBY and is not true of Jellyfin.
//
// WHAT THIS FILE IS. The pure, offline half of the third media-server data-plane gate. Everything that is a
// statement about *what a five-minute claim has to mean*, *what a report may contain* and *what ten seeks
// are* lives in `media-server-dataplane.ts` and is imported by the Jellyfin, Plex and Emby drivers
// unchanged. Everything whose truth depends on Emby lives here.
//
// WHY IT EXISTS AT ALL, GIVEN THAT JELLYFIN IS A FORK OF EMBY. Because "same API family" is a statement about
// endpoint spelling, and every conclusion in the Jellyfin gate that was hard to reach is a statement about
// BEHAVIOUR. Five of them were measured against a live, digest-pinned Emby 4.9.5.0 and found to be false for
// it — two of them false in the direction that lets this gate assert something STRONGER than the Jellyfin one
// can, and three of them false in a way that would have made a copied gate either hang, re-run a completed
// wizard on every phase, or silently compare its own arithmetic with itself.
//
// EVERY CONSTANT BELOW WAS MEASURED, NOT READ OFF A WIKI. The measurements are recorded beside each one, with
// the request that produced them, so that a future pinned version changing its mind is a failing assertion
// rather than a gate that quietly proves less. `docs/PROJECTION_PHASE_1_EMBY_DATA_PLANE.md` §3 carries the
// same findings in prose.
//
// NOTHING HERE IS COMPILED INTO, LINKED TO, OR READ BY `projectiond`. `test/projectiond-wiring.ts` refuses any
// Go file that names a media server, and that stays true: this is control-plane gate code.

// ---------------------------------------------------------------------------------------------------------
// The pinned server
// ---------------------------------------------------------------------------------------------------------

/**
 * The Emby version every measurement in this file was taken against.
 *
 * IT IS ASSERTED BY THE GATE RATHER THAN DECORATIVE. The image is pinned by digest, so this cannot drift
 * without somebody changing the digest — and if they do, the gate says which findings were re-measured and
 * which were inherited. A gate whose recorded behaviour belongs to a version it is no longer running is worse
 * than one with no record at all, because it reads like evidence.
 */
export const EMBY_PINNED_VERSION = '4.9.5.0';

/**
 * A version string in a form the acceptance plan's redaction rule will let through.
 *
 * THIS IS NOT COSMETIC, AND IT WAS FOUND BY THE OFFLINE SUITE RATHER THAN BY A RUN. §7 forbids an IP address
 * in a report, and the pattern that enforces it is four dot-separated groups of one to three digits. Emby's
 * version is `4.9.5.0`. It matches exactly, so the entirely reasonable note `server version 4.9.5.0` makes
 * `findRedactionProblems` refuse the whole report — at the very end of a half-hour run, after every assertion
 * has already passed.
 *
 * WHY THE VERSION IS KEPT AT ALL RATHER THAN DROPPED. Every measured finding in this file belongs to one
 * server version, and `EM1-pinned-version` exists to fail loudly when the digest is moved without the findings
 * being re-measured. A failure that could not name the version it actually met would be a failure nobody could
 * act on.
 *
 * WHY IT IS RENDERED RATHER THAN THE RULE WIDENED. Loosening the address pattern to admit "things that look
 * like versions" would put a hole in a rule that every report in this repository is checked against, in order
 * to accommodate one note. Rendering the note is local, reversible by eye, and leaves the rule intact.
 */
export function redactionSafeVersion(version: string): string {
  return version.replace(/\./g, '-');
}

/**
 * Where the ffmpeg this gate decodes with lives inside the pinned Emby image.
 *
 * MEASURED: `find / -name ffmpeg -type f` inside `emby/embyserver` returns `/bin/ffmpeg`, and `/bin/ffprobe`
 * beside it. Jellyfin's are under `/usr/lib/jellyfin-ffmpeg/`; Plex ships **no ffprobe at all**, which is why
 * that gate has to borrow a third party's decoder. Emby shipping its own is what lets this gate decode the
 * server's output with the server's own decoder, exactly as the Jellyfin gate does.
 */
export const EMBY_FFMPEG = '/bin/ffmpeg';
export const EMBY_FFPROBE = '/bin/ffprobe';

/**
 * Where the pinned Emby writes a transcoding job's own output.
 *
 * MEASURED, AND IT IS NOT CONFIGURABLE THE WAY JELLYFIN'S IS — see `EMBY_ENCODING_CONFIG_HAS_NO_TEMP_PATH`.
 * `GET /System/Configuration/encoding` on the pinned server returns seventeen keys and **none** of them is a
 * transcoding temp path; `GET /System/Configuration` has none either. The directory that actually appears and
 * fills with segments while a transcode runs is `/config/transcoding-temp`, inside the volume Emby already
 * declares. So the encoder-ahead measurement binds that path instead of setting one.
 */
export const EMBY_TRANSCODING_TEMP_PATH = '/config/transcoding-temp';

// ---------------------------------------------------------------------------------------------------------
// FINDING 1 — the startup wizard has no public completion flag
// ---------------------------------------------------------------------------------------------------------

/**
 * Emby's `/System/Info/Public` does NOT carry `StartupWizardCompleted`, and Jellyfin's does.
 *
 * MEASURED. `GET /System/Info/Public` against the pinned Emby, before and after the wizard, returns exactly
 * `LocalAddresses`, `RemoteAddresses`, `ServerName`, `Version`, `Id` (plus `LocalAddress`/`WanAddress` once
 * the server has worked out its own addresses). There is no wizard field in either response.
 *
 * WHY THAT IS A DEFECT AND NOT A DETAIL. The Jellyfin driver decides whether to run the first-run wizard with
 * `info?.StartupWizardCompleted !== true`. Against Emby that reads `undefined !== true`, which is **always
 * true** — so a copied bootstrap would re-run `/Startup/User` and `/Startup/Complete` on every invocation,
 * including the re-login the gate performs after restarting the media server. The gate calls `bootstrap`
 * twice on purpose, and the second call is supposed to prove the installation SURVIVED; a second wizard run
 * would be the gate destroying the evidence it came to collect.
 */
export const EMBY_PUBLIC_INFO_HAS_NO_WIZARD_FLAG = true;

/** What an unauthenticated probe of the wizard endpoint says about whether the wizard is still open. */
export type EmbyWizardPhase = 'open' | 'complete' | 'unknown';

/**
 * Whether the first-run wizard is still open, from the status of an UNAUTHENTICATED `GET
 * /Startup/Configuration`.
 *
 * THIS IS THE REPLACEMENT FOR THE FLAG EMBY DOES NOT PUBLISH, AND IT IS A MEASUREMENT RATHER THAN AN
 * INFERENCE. Against the pinned server:
 *
 *   - before the wizard: `GET /Startup/Configuration` with **no credential** answers **200** `{"UICulture":
 *     "en-us"}`, and so does `GET /System/Info`. An Emby that has never been set up serves its own
 *     configuration surface to anybody, which is what makes a non-interactive bootstrap possible at all.
 *   - after `POST /Startup/Complete`: the same request answers **401** `Access token is invalid or expired.`,
 *     and so does `GET /System/Info`.
 *
 * SO THE TRANSITION IS THE SIGNAL. It is read from the wizard's own endpoint rather than from `/System/Info`
 * because the two moved together in the measurement and only one of them is *about* the wizard; keying on the
 * general one would be keying on a coincidence.
 *
 * ANYTHING ELSE IS `unknown`, AND `unknown` IS NOT `complete`. A 503 from a server still starting up, or a
 * status a future version invents, must not be read as "the wizard is done" — that would skip the bootstrap
 * and fail four phases later with an unauthenticated 401 nobody could trace back to here.
 */
export function embyWizardPhase(unauthenticatedStartupStatus: number): EmbyWizardPhase {
  if (unauthenticatedStartupStatus === 200) return 'open';
  if (unauthenticatedStartupStatus === 401 || unauthenticatedStartupStatus === 403) return 'complete';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------------------
// FINDING 2 — the direct-play endpoint is NOT anonymous, and that is a stronger claim
// ---------------------------------------------------------------------------------------------------------

/**
 * Emby REFUSES an unauthenticated direct play. Jellyfin serves one.
 *
 * MEASURED, BOTH WAYS, AGAINST BOTH PINNED SERVERS. `GET /Videos/{id}/stream?static=true&mediaSourceId=…`:
 *
 *   - pinned Jellyfin: **200 with the whole file** to a request carrying no credential at all, which is what
 *     `PLAYBACK_ENDPOINT_IS_ANONYMOUS` in `media-server-dataplane.ts` records, and why the Jellyfin gate
 *     states plainly that its direct-play evidence is about BYTES and not about authorization.
 *   - pinned Emby 4.9.5.0: **401**, 35 bytes of body. With a valid token in `X-Emby-Authorization`: **200**,
 *     8,594,315 bytes, the file's own digest.
 *
 * WHY THIS IS RECORDED AS A STRENGTHENING RATHER THAN A DIFFERENCE. The Jellyfin gate had to *withhold* a
 * claim: it could not say the server authorized the read, because that server would have served it to
 * anybody. Emby's refusal is a fact this gate can assert — and it asserts it as a negative control, with the
 * anonymous request made deliberately and its 401 required. Inheriting Jellyfin's constant would have meant
 * declining to make a true claim about Emby because a different server could not support it, which is the
 * opposite of what a per-server module is for.
 *
 * WHAT IT COSTS. The paced consumer is an ffmpeg in a container reading the stream URL, and on Jellyfin it
 * carries no credential precisely because none is needed. On Emby it needs one, and getting a credential to
 * a container without putting it where `docker inspect` can read it is a real problem the gate has to solve
 * rather than wave at — see `EMBY_CONSUMER_CREDENTIAL_IS_FILE_BORNE`.
 */
export const EMBY_PLAYBACK_ENDPOINT_IS_ANONYMOUS = false;

/**
 * The verdict on the anonymous-playback negative control.
 *
 * A 200 here is a **failure**, and saying so is the whole point: it would mean the pinned Emby had started
 * serving media to unauthenticated callers, which is a regression in the media server that this gate is in a
 * position to notice. Anything that is neither 200 nor a refusal is also a failure, because the control has
 * then measured nothing — a connection error and a refusal are different facts.
 */
export function embyAnonymousPlaybackIsRefused(status: number): boolean {
  return status === 401 || status === 403;
}

// ---------------------------------------------------------------------------------------------------------
// FINDING 3 — the encoding configuration has no temp path and no throttle delay
// ---------------------------------------------------------------------------------------------------------

/**
 * `POST /System/Configuration/encoding` cannot be used to redirect a transcoding job's output on Emby.
 *
 * MEASURED. `GET /System/Configuration/encoding` on the pinned Emby returns exactly:
 * `EncodingThreadCount, ExtractionThreadCount, DownMixAudioBoost, EnableThrottling, ThrottleBufferSize,
 * ThrottleHysteresis, ThrottlingMethod, H264Crf, EnableHardwareEncoding, EnableSubtitleExtraction,
 * EnableOnTheFlyAttachmentExtraction, CodecConfigurations, HardwareAccelerationMode,
 * EnableHardwareToneMapping, EnableSoftwareToneMapping, TranscodingMaxWidth, EnableHevcEncoding`.
 *
 * There is no `TranscodingTempPath` and no `ThrottleDelaySeconds`. The Jellyfin driver's `configureEncoding`
 * sets both, and its comment explains that the temp path is *what makes the encoder observable at all*.
 *
 * SO THE EMBY GATE DOES NOT CONFIGURE; IT BINDS. `/config/transcoding-temp` is where the job writes, and the
 * gate bind-mounts Emby's `/config` anyway because that is where its library database lives. The encoder-ahead
 * number is therefore measured exactly as Jellyfin's is, from file mtimes under a directory on the host, and
 * is RECORDED rather than asserted for the same reason it is there — see `TranscodeSoakAnalysis`.
 *
 * `EnableThrottling` DEFAULTS TO FALSE HERE, and the gate leaves it alone. Turning it on would be tuning the
 * server to make a number the gate does not assert on look better, which is the shape of change that turns a
 * recorded measurement into a managed one.
 */
export const EMBY_ENCODING_CONFIG_HAS_NO_TEMP_PATH = true;

// ---------------------------------------------------------------------------------------------------------
// FINDING 4 — segment URLs carry no position, so the seek gate reads the playlist's own arithmetic
// ---------------------------------------------------------------------------------------------------------

/**
 * Emby's HLS segment URLs carry NO `runtimeTicks`. Jellyfin's do.
 *
 * MEASURED. A forced-transcode variant playlist from the pinned Emby lists 114 entries of the exact form
 * `hls1/main/0.ts?PlaySessionId=…`, `hls1/main/1.ts?PlaySessionId=…`, … `hls1/main/113.ts?PlaySessionId=…`.
 * The only query parameter is the play-session id. Jellyfin's generator appends `runtimeTicks`, which is that
 * server's own statement of where in the media the segment begins, and `segmentPositions` in the Jellyfin
 * driver prefers it.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. `analyseSeekSet` holds the position the gate ASKED for against the
 * position the SERVER said it was answering, and the whole value of that comparison is that the second number
 * comes from the server. If the second number silently became the gate's own arithmetic, the gate would be
 * comparing a number with itself and `maxPositionErrorSeconds` would be structurally zero — an assertion that
 * cannot fail, which is worse than no assertion.
 *
 * WHAT THE SERVER STATES INSTEAD, AND WHY IT IS STILL THE SERVER'S. The playlist carries
 * `#EXT-X-TARGETDURATION:4` and an `#EXTINF:3.0000, nodesc` before every segment. The cumulative sum of those
 * durations is where the server says each segment starts — it is the server's generator emitting its own
 * segment lengths, not the gate guessing them. Measured against the decoder, over three segments taken out of
 * order at indices 1, 106 and 22: cumulative starts 3, 318 and 66 seconds, decoded picture start times 13.0,
 * 328.0 and 76.0. **A constant offset of exactly 10.0 s in all three**, which is precisely the property
 * `decodedOffsetSpreadSeconds` exists to assert and which a server returning the same segment repeatedly
 * cannot produce.
 *
 * THE PLAYLIST TOTAL IS ALSO CHECKED AGAINST THE MEDIA. 114 x 3.0 s = 342.00 s against a 340 s source. The
 * seek gate asserts that drift, so a playlist describing different media from the one the positions were
 * computed against fails rather than quietly relocating every seek.
 */
export const EMBY_SEGMENT_URLS_CARRY_NO_RUNTIME_TICKS = true;

/** One segment as the server's own variant playlist describes it. */
export interface EmbyPlaylistSegment {
  /** The reference, exactly as the playlist wrote it. Relative on this server. */
  readonly ref: string;
  /** This segment's own `#EXTINF` duration, in seconds. */
  readonly seconds: number;
}

/**
 * Parse a variant playlist into the segments it lists and the durations it states for them.
 *
 * IT IS SEPARATE FROM THE DRIVER, AND PURE, SO THE AWKWARD PLAYLISTS CAN BE TESTED OFFLINE. A playlist whose
 * `#EXTINF` is malformed, one that lists a segment with no `#EXTINF` in front of it, and one that is nothing
 * but comments are all shapes a real server can emit under load or on an error path, and none of them is
 * convenient to produce against a live container.
 *
 * `#EXTINF:3.0000, nodesc` IS THE MEASURED SHAPE, and the trailing text after the comma is why the duration
 * is taken by splitting on the comma rather than by stripping one. An earlier reading of this that removed
 * only the first comma produced `3.0000 nodesc`, `Number(...)` of which is `NaN` — and a `NaN` cumulative
 * position would have made every seek assertion below it vacuous instead of failing.
 */
export function parseEmbyVariantPlaylist(playlist: string): EmbyPlaylistSegment[] {
  const out: EmbyPlaylistSegment[] = [];
  let pending: number | undefined;
  for (const raw of playlist.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const seconds = Number(line.slice('#EXTINF:'.length).split(',')[0]);
      pending = Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    // A SEGMENT WITH NO USABLE `#EXTINF` IN FRONT OF IT IS RECORDED AS ZERO-LENGTH RATHER THAN DROPPED.
    // Dropping it would renumber every segment after it, so a seek to index N would fetch a different
    // segment than the one whose position was computed — and nothing downstream could see that it had.
    out.push({ ref: line, seconds: pending ?? 0 });
    pending = undefined;
  }
  return out;
}

/**
 * Where the SERVER says each segment begins: the cumulative sum of its own `#EXTINF` durations.
 *
 * THIS IS EMBY'S ANSWER TO A QUESTION JELLYFIN ANSWERS IN THE URL. See
 * `EMBY_SEGMENT_URLS_CARRY_NO_RUNTIME_TICKS` for the measurement that made this the only available source and
 * for the decoder evidence that it is the right one.
 */
export function embySegmentPositions(segments: readonly EmbyPlaylistSegment[]): number[] {
  let cumulative = 0;
  return segments.map((segment) => {
    const start = cumulative;
    cumulative += segment.seconds;
    return start;
  });
}

/**
 * Everything wrong with a variant playlist, before a single seek is performed against it.
 *
 * IT REFUSES A PLAYLIST THE SEEK GATE COULD NOT MEAN ANYTHING AGAINST, which is a different job from
 * `seekPlanProblems`: that one checks the PLAN, this one checks the DOCUMENT the plan will be executed
 * through. A playlist of one segment, or one whose durations are all zero, passes every per-seek assertion in
 * the gate — ten requests, ten 200s, ten decodable segments — while making `serverPositionSeconds` identically
 * zero for all ten and `maxPositionErrorSeconds` a measurement of nothing.
 */
export function embyPlaylistProblems(
  segments: readonly EmbyPlaylistSegment[], mediaSeconds: number,
): string[] {
  const problems: string[] = [];
  if (segments.length < 2) {
    problems.push(`the playlist lists ${segments.length} segment(s), so no seek can land anywhere else`);
  }
  const total = segments.reduce((sum, segment) => sum + segment.seconds, 0);
  if (total <= 0) {
    problems.push('the playlist states no duration at all, so the server declares no position for any segment');
  } else if (mediaSeconds > 0 && Math.abs(total - mediaSeconds) > EMBY_PLAYLIST_DRIFT_CEILING_SECONDS) {
    problems.push(`the playlist describes ${total.toFixed(2)}s of media and the file decodes as `
      + `${mediaSeconds}s, so the seek positions were computed against different media`);
  }
  if (segments.some((segment) => segment.ref === '')) problems.push('the playlist names an empty segment');
  if (new Set(segments.map((segment) => segment.ref)).size !== segments.length) {
    problems.push('the playlist names the same segment twice, so two seeks could not be distinguished');
  }
  return problems;
}

/**
 * How far the playlist's own total may sit from the media's decoded duration.
 *
 * MEASURED: 342.00 s of `#EXTINF` against a 340 s source, so the honest ceiling is a little over one segment
 * — the server rounds its segment lengths up to whole seconds and the last one is padded. Zero would fail a
 * correct server; a large number would stop the check noticing a playlist for the wrong item.
 */
export const EMBY_PLAYLIST_DRIFT_CEILING_SECONDS = 6;

// ---------------------------------------------------------------------------------------------------------
// FINDING 5 — the container's init runs as root, so a write-refusal test has to name the uid
// ---------------------------------------------------------------------------------------------------------

/**
 * The Emby image drops privilege INTERNALLY. `docker exec` lands as root; the server does not run as root.
 *
 * MEASURED. The image's entrypoint is `/init`, an s6 supervision tree, and its config carries `UID=2`,
 * `GID=2`, `PUID=`, `PGID=` — the documented way to choose the uid is the environment, not `--user`. Started
 * with `-e UID=1000 -e GID=1000`, `ps -o user,comm` inside the container shows `root s6-svscan`,
 * `root s6-supervise`, … and **`1000 EmbyServer`**; `docker exec … id` reports `uid=0(root)`.
 *
 * Jellyfin is run by its gate as `--user 1000:1000`, so every process in that container — including a
 * `docker exec` — is the media server's own uid, and the write-refusal step asserts `id -u != 0` inline.
 *
 * WHY COPYING THAT WOULD HAVE BEEN A SILENT DOWNGRADE. The same script inside the Emby container asserts
 * `id -u != 0`, gets `0`, and **fails** — so it would have been noticed. The dangerous version is the one
 * where somebody deletes the assertion to make it pass: the mutation attempts then run as root, and root
 * failing to write to a read-only FUSE mount is a much weaker statement than an ordinary uid failing to,
 * because it is the one case where the kernel's own permission bits would not have refused anyway.
 *
 * SO THE GATE RUNS IT TWICE, AS BOTH, AND ASSERTS BOTH. `docker exec -u 1000:1000` is the media server's own
 * identity and is the claim that matters; `docker exec` as root is the stronger claim that the DAEMON is what
 * refuses, since no permission bit is standing in the way. Neither alone says what both say.
 */
export const EMBY_CONTAINER_INIT_RUNS_AS_ROOT = true;

/** The uid the gate runs the Emby server process as, via the image's own `UID`/`GID` environment. */
export const EMBY_SERVER_UID = 1000;
export const EMBY_SERVER_GID = 1000;

// ---------------------------------------------------------------------------------------------------------
// The consumer's credential, which finding 2 forces this gate to solve
// ---------------------------------------------------------------------------------------------------------

/**
 * The paced consumer reads its credential from a FILE, and never from an argument vector Docker records.
 *
 * WHY THIS IS HERE RATHER THAN LEFT IMPLICIT. Because Emby refuses anonymous playback (finding 2), the
 * five-minute paced-play phase has to hand a live token to an ffmpeg running in another container. The
 * obvious spelling is `docker run … --entrypoint ffmpeg … -headers "X-Emby-Token: <token>" …`, and it puts a
 * live credential into `docker inspect`, into `docker ps --no-trunc`, and into the host's process table for
 * the lifetime of the container. The Jellyfin gate explicitly refuses to do this — and gets to refuse for
 * free, because that server needs no credential at all.
 *
 * WHAT THIS GATE DOES INSTEAD. The token is written to a file inside the gate's own run directory, which is
 * already bind-mounted into the consumer and which the cleanup trap deletes on success and on failure. The
 * consumer's command is a small shell script, also in the run directory, that reads the file and execs
 * ffmpeg. `docker run`'s argv therefore names a script path and nothing else, and the gate ASSERTS that the
 * token appears nowhere in `docker inspect` of the consumer container.
 *
 * WHAT IT DOES NOT SOLVE, STATED RATHER THAN OMITTED. ffmpeg has no file-based header option, so the token is
 * in the argv of the ffmpeg process INSIDE its own container for as long as it runs. That is recorded in the
 * data-plane document and is not asserted away. It is a smaller surface than `docker inspect` — which
 * persists after the container is gone and is readable by anything that can reach the Docker socket — but it
 * is not nothing, and a gate that claimed "the credential never appears in a process listing" would be
 * claiming more than it measured.
 */
export const EMBY_CONSUMER_CREDENTIAL_IS_FILE_BORNE = true;

/**
 * How much longer the paced consumer is told to decode than the gate asserts it decoded.
 *
 * THIS IS A PROPERTY OF ffmpeg, NOT OF EMBY, AND IT IS NOT A WEAKENING OF G8. `ffmpeg -t 300` stops at the
 * last output frame at or before 300 s, so the final `-progress` record reports marginally UNDER 300 s of
 * decoded media — and `Math.floor` of that is 299. The acceptance plan's floor is 300 decoded media seconds,
 * and asking the consumer for exactly the number being asserted makes the gate turn on a rounding boundary
 * rather than on behaviour.
 *
 * MEASURED: a run of this gate failed `EM18-paced-play-decoded-media-seconds` at **299 against 300**, with
 * startup 2.3 s, no stall and a healthy pacing ratio — a completely correct five minutes of paced playback,
 * failed by an off-by-one in the harness. The Jellyfin and Plex gates carry the same knife-edge and have so
 * far landed on the other side of it.
 *
 * THE ASSERTION IS UNCHANGED AT THE PLAN'S 300. Only the request moves, and it moves UP: the consumer is
 * asked to decode more than the gate requires, so a pass means at least five minutes of decoded media rather
 * than exactly five minutes measured with a favourable rounding. Every other bound still applies over the
 * longer window — the pacing ratio, the stall ceiling and the wall clock are all measured across whatever the
 * consumer actually did.
 */
export const PACED_PLAY_DECODE_MARGIN_SECONDS = 6;

/**
 * The token file's name inside the consumer's bind-mounted work directory.
 *
 * A CONSTANT SHARED BY THE WRITER AND THE READER, because the two live in different languages — the driver
 * writes it from TypeScript and a `/bin/sh` script reads it — and a mismatched literal would produce an
 * ffmpeg that sends an empty header and a 401 nobody would trace back to a typo.
 */
export const EMBY_CONSUMER_TOKEN_FILE = 'emby-consumer-token';

/**
 * Everything wrong with a `docker inspect` of the paced consumer, from a credential-exposure point of view.
 *
 * IT TAKES THE INSPECT OUTPUT AS TEXT AND THE SECRET AS A VALUE, so the check is "does this exact live token
 * appear", not "does something token-shaped appear". A pattern-based check over a JSON blob would produce
 * false positives on any base64-looking string and would tempt somebody into loosening it.
 */
export function embyConsumerExposureProblems(inspectJson: string, token: string): string[] {
  const problems: string[] = [];
  if (token === '') return ['the exposure check was handed an empty token, so it searched for nothing'];
  if (inspectJson.includes(token)) {
    problems.push('the consumer container\'s Docker metadata contains the live access token');
  }
  // The header NAME appearing in argv means somebody put the header on the command line, which is the exact
  // shape this arrangement exists to avoid — worth catching even in the run where the value was interpolated
  // from a variable that happened to be empty.
  if (/-headers\b/.test(inspectJson) && /X-Emby-Token/i.test(inspectJson)) {
    problems.push('the consumer container was launched with an inline credential header in its argument vector');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// What an ordinary file looks like to Emby
// ---------------------------------------------------------------------------------------------------------

/**
 * FINDING 6 — Emby's `/Items` never returns `LocationType`, and asking for it does not help.
 *
 * MEASURED, TWICE, WITH THE FIELD EXPLICITLY REQUESTED. `GET /Items?…&fields=Path,MediaSources` and
 * `…&fields=Path,MediaSources,LocationType` return the **identical** key set on the pinned server:
 * `Name, ServerId, Id, Container, MediaSources, Path, RunTimeTicks, Size, Bitrate, IsFolder, Type, UserData,
 * ImageTags, BackdropImageTags, MediaType`. `LocationType` is absent from both. Jellyfin returns it, and the
 * Jellyfin gate's ordinary-file predicate requires it to read `FileSystem`.
 *
 * THIS WAS FOUND BY A FAILING RUN, NOT BY READING. The first complete attempt at this gate catalogued both
 * published entries — `EM3-scan1-item-count` measured 2 against 2 — and then matched **zero** of them,
 * because an inherited predicate was requiring a field this server does not send.
 *
 * WHAT `LocationType === 'FileSystem'` ACTUALLY BOUGHT, so that dropping it is not the response. It refused
 * two things: an item the server catalogued as `Virtual` — a placeholder it never opened — and one it
 * considered `Remote`. Both are exactly the failures this appliance exists to avoid being mistaken for.
 *
 * WHAT EMBY SUPPLIES INSTEAD, and why it is a straighter answer to the same question rather than a weaker
 * one. `MediaSources[0].Type` is the media-source kind, and it reads `"Default"` for a real file; the value
 * that means "catalogued but not backed by openable media" is `"Placeholder"`. That is the same refusal
 * `Virtual` performed, made against the media source rather than inferred from the item. And
 * `MediaSources[0].Path` is the file the source actually points at, which the Jellyfin predicate never
 * checked at all — so requiring it to equal the item's own projected path is a check this family of gates did
 * not previously have.
 *
 * NET: one field this server does not send is replaced by two it does, one of which is strictly more than
 * the original asserted. `test/projection-emby-dataplane.ts` holds both.
 */
export const EMBY_ITEMS_OMIT_LOCATION_TYPE = true;

/**
 * The media-source kind that means "this item is not backed by openable media".
 *
 * It is named rather than inlined because it is the direct replacement for Jellyfin's `LocationType: 'Virtual'`
 * refusal, and a reader comparing the two predicates should be able to find the correspondence.
 */
export const EMBY_PLACEHOLDER_SOURCE_TYPE = 'Placeholder';

/** The fields of an Emby media source that bear on "the server sees a file on a disk". */
export interface EmbyItemView {
  readonly key: string;
  readonly protocol: string;
  readonly container: string;
  readonly isRemote: boolean;
  readonly supportsDirectPlay: boolean;
  /** `MediaSources[0].Type`. `Placeholder` is what `LocationType: 'Virtual'` meant on Jellyfin. */
  readonly mediaSourceType: string;
  /** The item's own projected path, as the server reports it. */
  readonly path: string;
  /** `MediaSources[0].Path` — the file the source actually points at. */
  readonly mediaSourcePath: string;
}

/**
 * Everything about an item that stops it being an ordinary local file, named individually.
 *
 * WHY IT RETURNS REASONS RATHER THAN A BOOLEAN. This is the claim the whole appliance rests on — a media
 * server treats the projection as a disk — and when it fails, "false" is not a diagnosis. `Protocol=Http`
 * means the server decided to fetch the media itself; `LocationType=Virtual` means it catalogued a placeholder
 * it never opened; an empty container means it never successfully probed the file. Those are three completely
 * different failures of this product and they should not arrive as the same word.
 *
 * MEASURED SHAPE ON THE PINNED EMBY, for a file under a bind-mounted directory: `Protocol: "File"`,
 * `IsRemote: false`, `Container: "mp4"`, `SupportsDirectPlay: true`, `MediaSources[0].Type: "Default"`,
 * `MediaSources[0].Path` equal to the item's own `Path`, and `MediaSources[0].Id` of the form `mediasource_6`
 * against an item `Id` of `6`. **There is no `LocationType`** — see `EMBY_ITEMS_OMIT_LOCATION_TYPE` for the
 * measurement and for why the two checks below replace it rather than the check being dropped.
 */
export function embyOrdinaryFileProblems(item: EmbyItemView): string[] {
  const problems: string[] = [];
  if (item.protocol !== 'File') {
    problems.push(`the server reports protocol ${item.protocol || '(none)'}, so it is not reading a local file`);
  }
  if (item.isRemote) problems.push('the server considers the media remote');
  // THE REPLACEMENT FOR JELLYFIN'S `LocationType: 'Virtual'` REFUSAL, made against the media source rather
  // than inferred from the item. See `EMBY_ITEMS_OMIT_LOCATION_TYPE`.
  if (item.mediaSourceType === EMBY_PLACEHOLDER_SOURCE_TYPE) {
    problems.push('the media source is a placeholder, so the server catalogued an item it never opened');
  }
  if (item.mediaSourceType === '') {
    problems.push('the media source states no kind at all, so nothing rules out a placeholder');
  }
  // AND THE HALF THE JELLYFIN PREDICATE NEVER HAD. An item whose media source points somewhere other than the
  // projected path is one the server would read from somewhere this product did not publish.
  if (item.mediaSourcePath !== item.path) {
    problems.push('the media source points at a different file from the item\'s own projected path');
  }
  if (item.container === '') problems.push('the server never established a container, so it did not probe the file');
  if (!item.supportsDirectPlay) problems.push('the server does not believe it can direct-play the file');
  if (item.key.endsWith('.strm')) problems.push('a .strm placeholder is a pointer, not a projected file');
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// Emby's own identifiers, and what a churn assertion may read into them
// ---------------------------------------------------------------------------------------------------------

/**
 * Emby item ids are small decimal integers, minted by its own database. Jellyfin's are GUIDs.
 *
 * MEASURED: the library created by this gate has `ItemId: "3"` and its first movie has `Id: "6"`, with
 * `MediaSources[0].Id` of `mediasource_6`. Jellyfin mints a 32-hex GUID derived from the item's path.
 *
 * WHAT THIS CHANGES FOR THE CHURN GATE, WHICH IS LESS THAN IT LOOKS AND IS WORTH STATING ANYWAY. `zero item-id
 * churn` means "an item carried across an event kept the id it was first given", and that is exactly as
 * meaningful against a row id as against a GUID: a scanner that deleted and re-created the row gets a new
 * number. What it does NOT mean on Emby is what it incidentally also means on Jellyfin — that the id is a
 * function of the path, so a matching id independently corroborates a matching path. On Emby the id is a
 * counter, so the gate's path and size comparisons are carrying that half on their own, and this comment
 * exists so nobody later reads more into a stable Emby id than a stable Emby id supports.
 */
export const EMBY_ITEM_IDS_ARE_DATABASE_ROW_IDS = true;

/** Whether an id has the shape Emby was measured to mint. Used to notice a future version changing it. */
export function isEmbyItemId(id: string): boolean {
  return /^[0-9]+$/.test(id);
}
