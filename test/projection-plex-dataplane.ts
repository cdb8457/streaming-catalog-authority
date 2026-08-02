import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_SOAK, SEEK_PLAN_FRACTIONS, TRANSCODE_SOURCE_VIDEO_CODEC,
  TRANSCODE_TARGET_VIDEO_CODEC, findRedactionProblems, seekPlanProblems,
} from '../src/core/projection/media-server-dataplane.js';
import {
  PLEX_ACCEPT_JSON, PLEX_CLIENT, PLEX_ENCODER_FLOORS, PLEX_HAS_NO_CLIENT_WRITABLE_PLAY_METHOD, PLEX_LIBRARY,
  PLEX_SEGMENT_CONTAINER, PLEX_SERVER_PREFS, PLEX_UNCLAIMED_LOCAL_API_REQUIRES_PLEX_TV_REACHABILITY,
  PlexScanBarrier, analysePlexEncoderLiveness, parsePlexVariantPlaylist, plexActivityIsLibraryWork,
  plexClientQuery, plexCreateSectionPath, plexDirectPlayPath, plexHasQueryCredential,
  plexPartIsOrdinaryFile, plexPrefsPath, plexSeekPositionErrorCeilingSeconds, plexSegmentPath,
  plexSegmentPlanFor, plexStripQueryCredentials, plexTranscodePingPath, plexTranscodeStartPath,
  plexTranscodeStopPath, plexVariantPlaylistPath,
  type PlexEncoderSample, type PlexScanSample,
} from '../src/core/projection/plex-dataplane.js';
import {
  applyPreferences, awaitServer, directPlay, isOrdinaryFile, listMovies, openPinnedStream, rangeRead,
  scanLibrary, withoutLocators, type GateState, type ItemRecord,
} from '../src/ops/projection-plex-dataplane.js';

// Projection Phase 1 — the offline half of the PLEX data-plane gate.
//
// WHAT THIS SUITE IS FOR. The gate itself needs Docker, /dev/fuse, a real PostgreSQL, a real Plex and egress
// to plex.tv, and it takes half an hour. This suite runs everywhere, in seconds, and holds the rules the gate
// depends on: that every wait is bounded, that a skipped run cannot look like a passing one, that the request
// shapes carry no credential, that the scan barrier and the held-open stream BEHAVE as claimed, and that the
// report cannot leak.
//
// SEVERAL OF THESE ARE BEHAVIOURAL RATHER THAN STRUCTURAL, AND DELIBERATELY SO. The Jellyfin gate's defect
// list is almost entirely "a comment described one behaviour while the code did another, or a check that
// could not fail", and a regex over the source agrees with every one of those comments. So the barrier is
// driven with scripted samples INCLUDING the Plex-specific window in which `refreshing` has gone false while
// the library is still being written; the driver is driven against a real socket serving real Plex-shaped
// JSON; and the wrapper accounting is driven by running the wrapper with a stub gate.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

const TEST_DEADLINE_MS = 30_000;

async function withDeadline<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`test deadline of ${TEST_DEADLINE_MS}ms exceeded: ${label}`)),
          TEST_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await withDeadline(name, async () => { await fn(); });
    passed += 1; console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1; failures.push([name, error]); console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

console.log('Projection Phase 1 — Plex data plane (offline)');

// ---------------------------------------------------------------------------------------------------------
// The variant playlist, and the server's own arithmetic
// ---------------------------------------------------------------------------------------------------------

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:8',
  '#EXT-X-ALLOW-CACHE:NO',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXTINF:8, nodesc',
  '00000.ts',
  '#EXTINF:8, nodesc',
  '00001.ts',
  '#EXTINF:6.5, nodesc',
  '00002.ts',
  '#EXT-X-ENDLIST',
].join('\n');

await test('a variant playlist becomes the SERVER\'s statement of where each segment starts', () => {
  const entries = parsePlexVariantPlaylist(PLAYLIST);
  assertEq(entries.length, 3, 'three segments');
  assertEq(entries[0]?.startSeconds, 0, 'the first starts at zero');
  assertEq(entries[1]?.startSeconds, 8, 'the second at the first\'s duration');
  assertEq(entries[2]?.startSeconds, 16, 'and the third at the running sum');
  assertEq(entries[2]?.seconds, 6.5, 'a short final segment keeps its own declared duration');
  assertEq(entries[1]?.ref, '00001.ts', 'the reference is the media line');
});

await test('the start positions come from #EXTINF and NOT from a segment length the gate assumed', () => {
  // THE WHOLE REASON THIS IS A PARSER AND NOT `index * 8`. A server that changed its segmenter would make
  // every seek position in the gate wrong while every per-seek assertion still passed.
  const irregular = ['#EXTINF:3,', 'a.ts', '#EXTINF:11,', 'b.ts', '#EXTINF:5,', 'c.ts'].join('\n');
  const entries = parsePlexVariantPlaylist(irregular);
  assertEq(entries[1]?.startSeconds, 3, 'the second starts after the first\'s three seconds');
  assertEq(entries[2]?.startSeconds, 14, 'and the third after three plus eleven');
});

await test('CRLF playlists parse identically, because a checkout can hand us either', () => {
  const entries = parsePlexVariantPlaylist(PLAYLIST.replace(/\n/g, '\r\n'));
  assertEq(entries.length, 3, 'three segments');
  assertEq(entries[2]?.startSeconds, 16, 'and the same positions');
});

await test('a media line with no #EXTINF is DROPPED rather than guessed at', () => {
  // Guessing a duration for it would corrupt every start position after it, and the gate would then assert
  // positions the server never stated. Dropping it makes the segment count wrong, which the caller catches.
  const entries = parsePlexVariantPlaylist(['#EXTINF:8,', 'a.ts', 'orphan.ts', '#EXTINF:8,', 'b.ts'].join('\n'));
  assertEq(entries.length, 2, 'the orphan is not a segment');
  assertEq(entries[1]?.startSeconds, 8, 'and the positions after it are still the server\'s sums');
});

await test('an empty playlist yields no entries rather than a zero-length segment', () => {
  assertEq(parsePlexVariantPlaylist('#EXTM3U\n#EXT-X-ENDLIST').length, 0, 'nothing to seek to');
});

await test('a seek picks the segment the position falls INSIDE, not the nearest boundary', () => {
  const entries = parsePlexVariantPlaylist(PLAYLIST);
  assertEq(plexSegmentPlanFor(entries, 0)?.index, 0, 'the very start');
  assertEq(plexSegmentPlanFor(entries, 7.9)?.index, 0, 'still inside the first');
  assertEq(plexSegmentPlanFor(entries, 8)?.index, 1, 'the boundary belongs to the segment it opens');
  assertEq(plexSegmentPlanFor(entries, 15.5)?.index, 1, 'a position a player would play from segment one');
  assertEq(plexSegmentPlanFor(entries, 20)?.index, 2, 'inside the last');
});

await test('a position past the end lands on the last segment, and one before the start on the first', () => {
  const entries = parsePlexVariantPlaylist(PLAYLIST);
  assertEq(plexSegmentPlanFor(entries, 9_999)?.index, 2, 'the last is the closest honest answer');
  assertEq(plexSegmentPlanFor(entries, -5)?.index, 0, 'and the first, in the other direction');
  assertEq(plexSegmentPlanFor([], 10), undefined, 'an empty playlist has no answer at all');
});

await test('the seek position ceiling is ONE SEGMENT as the server declared it, not a shared constant', () => {
  // Jellyfin's segments are three seconds and the shared constant is four. Plex's are eight. Reusing four
  // would fail a correct Plex seek about half the time; widening the shared constant would have slackened
  // the Jellyfin gate by five seconds to make a different gate pass.
  const entries = parsePlexVariantPlaylist(PLAYLIST);
  assertEq(plexSeekPositionErrorCeilingSeconds(entries), 9, 'the longest declared segment, plus a second');
  assertEq(plexSeekPositionErrorCeilingSeconds([]),
    MEDIA_SERVER_SOAK.MAX_SEEK_POSITION_ERROR_SECONDS + 1,
    'with no playlist to measure, it falls back to the shared constant rather than to infinity');
  assert(plexSeekPositionErrorCeilingSeconds(entries) > MEDIA_SERVER_SOAK.MAX_SEEK_POSITION_ERROR_SECONDS,
    'and the Plex ceiling really is wider than the shared one, which is why it is derived');
});

await test('the shared ten-seek plan is still well-formed, and still meets what G9 asks of Plex', () => {
  assertEq(seekPlanProblems(SEEK_PLAN_FRACTIONS).length, 0, 'the shared plan is well-formed');
  assertEq(SEEK_PLAN_FRACTIONS.length, MEDIA_SERVER_SOAK.SEEK_COUNT, 'exactly ten positions');
  const deep = SEEK_PLAN_FRACTIONS.filter((f) => f > MEDIA_SERVER_SOAK.DEEP_SEEK_FRACTION).length;
  assert(deep >= 2, `at least two positions past 90% of duration, found ${deep}`);
  let backward = 0;
  for (let i = 1; i < SEEK_PLAN_FRACTIONS.length; i += 1) {
    if ((SEEK_PLAN_FRACTIONS[i] as number) < (SEEK_PLAN_FRACTIONS[i - 1] as number)) backward += 1;
  }
  assert(backward >= 3, `at least three backward transitions, found ${backward}`);
});

// ---------------------------------------------------------------------------------------------------------
// "An ordinary file", as Plex is able to say it
// ---------------------------------------------------------------------------------------------------------

const ORDINARY = {
  file: '/media/projection/Movies/A (2026)/A (2026).mp4',
  sizeBytes: 1_234,
  container: 'mp4',
  accessible: true,
  exists: true,
};

await test('an ordinary file is one Plex just STAT\'ED, not one its scanner remembers', () => {
  assert(plexPartIsOrdinaryFile(ORDINARY), 'the ordinary case');
  assert(!plexPartIsOrdinaryFile({ ...ORDINARY, accessible: undefined }),
    'ABSENT is a failure, not a pass: it means the listing was fetched without checkFiles=1 and the server '
    + 'never looked. Treating "not checked" as "fine" would silently downgrade every corpus assertion.');
  assert(!plexPartIsOrdinaryFile({ ...ORDINARY, exists: undefined }), 'and the same for exists');
  assert(!plexPartIsOrdinaryFile({ ...ORDINARY, accessible: false }), 'an unreadable file is not ordinary');
  assert(!plexPartIsOrdinaryFile({ ...ORDINARY, exists: false }), 'nor is a missing one');
  assert(!plexPartIsOrdinaryFile({ ...ORDINARY, container: '' }), 'nor one with no container');
  assert(!plexPartIsOrdinaryFile({ ...ORDINARY, sizeBytes: 0 }), 'nor one with no bytes');
  assert(!plexPartIsOrdinaryFile({ ...ORDINARY, file: '' }), 'nor one with no path');
  assert(!plexPartIsOrdinaryFile({ ...ORDINARY, file: '/mnt/x.strm' }), 'nor a .strm placeholder');
});

// ---------------------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------------------

await test('this gate authors no credential anywhere in a request', () => {
  const everything = [
    plexCreateSectionPath('L', '/media/projection/Movies'),
    plexPrefsPath(),
    plexDirectPlayPath('/library/parts/1/2/file.mp4'),
    plexTranscodeStartPath('/library/metadata/1', 's'),
    plexVariantPlaylistPath('s'),
    plexSegmentPath('s', 3),
    plexTranscodePingPath('s'),
    plexTranscodeStopPath('s'),
  ];
  for (const path of everything) {
    assert(!plexHasQueryCredential(path), `no credential in ${path.split('?')[0]}`);
    assert(!/x-plex-token/i.test(path), `and not even the parameter name in ${path.split('?')[0]}`);
  }
  assert(!Object.keys(plexClientQuery()).some((k) => /token/i.test(k)), 'nor in the client identity');
});

await test('a credential the SERVER put in a generated URL is recognised and stripped', () => {
  const dirty = '/library/parts/1/2/file.mp4?X-Plex-Token=abc123&download=1';
  assert(plexHasQueryCredential(dirty), 'the token is recognised');
  assertEq(plexStripQueryCredentials(dirty), '/library/parts/1/2/file.mp4?download=1', 'and removed');
  assert(plexHasQueryCredential('/x?x-plex-token=abc'), 'case does not hide it');
  assert(plexHasQueryCredential('/x?X-Plex-Session-Identifier=zzz'),
    'and neither does the session identifier, which is the other thing Plex propagates');
  assertEq(plexStripQueryCredentials('/x?X-Plex-Token=a'), '/x', 'a query of nothing else becomes no query');
  assertEq(plexStripQueryCredentials('/x'), '/x', 'a path with no query is untouched');
  assert(!plexHasQueryCredential('/x?tokenish=1'), 'a parameter that merely contains the word is not one');
});

await test('the redaction rule knows what a Plex credential looks like', () => {
  // It lives in the SHARED list rather than here, because that list is what every report in this family is
  // checked against and a rule that only covered the server whose gate happened to run has a hole in it.
  assert(findRedactionProblems({ note: 'X-Plex-Token=abc' }).length > 0, 'a Plex token is refused');
  assert(findRedactionProblems({ note: 'x-plex-token' }).length > 0, 'in either case');
  assert(findRedactionProblems({ gate: 'PX3-corpus-matched', measured: 50 }).length === 0,
    'and an ordinary result is not');
});

await test('a diagnostic from the consumer has its locators scrubbed before it can be printed', () => {
  const stderr = 'http://projection-px-server-1:32400/library/parts/1/2/file.mp4: 404 at 172.22.0.4';
  const clean = withoutLocators(stderr);
  assert(!clean.includes('://'), 'no locator survives');
  assert(!/\d+\.\d+\.\d+\.\d+/.test(clean), 'and no address');
  assert(clean.includes('404'), 'while the part worth keeping does');
});

// ---------------------------------------------------------------------------------------------------------
// The library, and the preferences
// ---------------------------------------------------------------------------------------------------------

await test('the library uses Plex\'s OFFLINE personal-media agent, never the online movie agent', () => {
  assertEq(PLEX_LIBRARY.agent, 'tv.plex.agents.none', 'the personal-media agent');
  assertEq(PLEX_LIBRARY.scanner, 'Plex Video Files', 'and the scanner that pairs with it');
  const path = plexCreateSectionPath('Projection Movies', '/media/projection/Movies');
  assert(path.includes('agent=tv.plex.agents.none'), 'the request names it');
  assert(!path.includes('tv.plex.agents.movie'), 'and never the agent that matches against plex.tv');
  assert(!path.includes('com.plexapp.agents.imdb'), 'nor the legacy one');
  assert(path.includes(encodeURIComponent('/media/projection/Movies')), 'the location is the mount');
});

await test('every background job that reads a WHOLE media file on a timer is turned off', () => {
  const prefs = new Map(PLEX_SERVER_PREFS.map(([key, value]) => [key, value]));
  // Each of these would land inside the amplification window and be attributed to a library scan, and the
  // report would then accuse the daemon of downloading the library.
  for (const key of ['ButlerTaskDeepMediaAnalysis', 'ButlerTaskUpgradeMediaAnalysis',
    'ButlerTaskRefreshLocalMedia', 'ButlerTaskGenerateMediaIndexFiles', 'GenerateIndexFilesDuringAnalysis']) {
    assertEq(prefs.get(key), '0', `${key} is off`);
  }
  for (const key of ['GenerateBIFBehavior', 'GenerateChapterThumbBehavior', 'LoudnessAnalysisBehavior']) {
    assertEq(prefs.get(key), 'never', `${key} is never`);
  }
  for (const key of ['FSEventLibraryUpdatesEnabled', 'ScheduledLibraryUpdatesEnabled',
    'ButlerTaskRefreshLibraries']) {
    assertEq(prefs.get(key), '0', `${key} is off, so a scan happens only when this gate asks for one`);
  }
});

await test('the trash is emptied automatically ON PURPOSE, so a removal can actually be a removal', () => {
  // With the trash held, a file that had genuinely vanished would sit in the library as an unavailable item
  // and every "zero removed" assertion would be true of a library that had lost its media — a check that
  // cannot fail, which is the class this repository exists to stop shipping.
  const prefs = new Map(PLEX_SERVER_PREFS.map(([key, value]) => [key, value]));
  assertEq(prefs.get('autoEmptyTrash'), '1', 'auto-empty is on');
});

await test('the preferences request carries every preference, and no credential', () => {
  const path = plexPrefsPath();
  for (const [key, value] of PLEX_SERVER_PREFS) {
    assert(path.includes(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`), `${key} is in the URL`);
  }
  assert(!plexHasQueryCredential(path), 'and no credential');
});

// ---------------------------------------------------------------------------------------------------------
// The transcode request, and what it does and does not prove
// ---------------------------------------------------------------------------------------------------------

await test('the transcode request forces a re-encode, and names a platform that resolves a PROFILE', () => {
  const path = plexTranscodeStartPath('/library/metadata/1', 'sess');
  assert(path.includes('directPlay=0'), 'direct play refused');
  assert(path.includes('directStream=0'), 'and direct stream, so the video really is re-encoded');
  assert(path.includes('protocol=hls'), 'over HLS');
  assert(path.includes('session=sess'), 'keyed on this gate\'s own session');
  // MEASURED: `X-Plex-Platform=Linux` answers 400 with "unable to find a matching profile". The transcode
  // endpoint resolves a client profile from these fields and refuses when it cannot.
  assertEq(PLEX_CLIENT.platform, 'Chrome', 'a platform the server has a profile for');
  assert(String(PLEX_CLIENT.platform) !== 'Linux', 'and NOT the one that answers 400');
  assert(path.includes('X-Plex-Platform=Chrome'), 'and the request says so');
});

await test('offset is always zero on the start request, because Plex does not seek that way', () => {
  // MEASURED: a session opened at offset=300 lists the WHOLE file, identically to offset=0, and answers
  // segments below the offset with an 188-byte body. Seeking is done by asking for the segment you want.
  assert(plexTranscodeStartPath('/library/metadata/1', 's').includes('offset=0'), 'the default is zero');
  assertEq(PLEX_SEGMENT_CONTAINER, 'mpegts', 'and the segments are transport streams');
});

await test('the transcode claim rests on decoded output, not on a field the server happens to author', () => {
  assert(PLEX_HAS_NO_CLIENT_WRITABLE_PLAY_METHOD,
    'Plex has no client-writable play-method field — the Jellyfin hazard does not exist here');
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  // The source codec and the output codec assertions are made in `transcode-verify` and
  // `transcode-soak-verify`, over a decoder's answers. The server's own decision is RECORDED.
  assert(cli.includes('PX6-server-decision-recorded'), 'the server\'s decision is recorded');
  assert(cli.includes('PX20-server-telemetry-recorded'), 'and so is its soak telemetry');
  assert(cli.includes(`verdict: 'pass'`), 'both as unconditional records rather than as assertions');
  assert(cli.includes('an independent decoder says the output is'),
    'while the codec assertion is made over the decoder\'s answer');
});

await test('the source and target codecs are the ones that make "a transcode ran" checkable', () => {
  assertEq(TRANSCODE_SOURCE_VIDEO_CODEC, 'mpeg4', 'encoded as one thing');
  assertEq(TRANSCODE_TARGET_VIDEO_CODEC, 'h264', 'and asked for as another');
  assert(String(TRANSCODE_SOURCE_VIDEO_CODEC) !== String(TRANSCODE_TARGET_VIDEO_CODEC),
    'a "transcode to h264" from an h264 source would prove nothing');
});

// ---------------------------------------------------------------------------------------------------------
// The scan barrier — the Plex-specific trap, driven as behaviour
// ---------------------------------------------------------------------------------------------------------

const BUSY: PlexScanSample = { refreshing: true, scannedAt: 100, activities: ['library.update.section', 'butler'] };
const SETTLING: PlexScanSample = {
  refreshing: false, scannedAt: 200, activities: ['library.update.item.metadata', 'butler'],
};
const IDLE: PlexScanSample = { refreshing: false, scannedAt: 200, activities: ['butler'] };

await test('`refreshing` going false is NOT the scan finishing, and the barrier knows it', () => {
  // THE MEASURED TRAP. Polling a fifty-entry scan: `refreshing` went false at t=6s and
  // `library.update.item.metadata` activities were still outstanding at t=32s. A barrier that watched only
  // the flag would return while Plex was still writing item metadata, and every assertion afterwards would
  // be made against a library mid-write. The failure would be intermittent and would look like flakiness.
  const barrier = new PlexScanBarrier(100);
  assertEq(barrier.observe(BUSY), 'running', 'refreshing is motion');
  assertEq(barrier.observe(SETTLING), 'running',
    'the flag has gone false but item metadata is still being written: that is NOT complete');
  assertEq(barrier.observe(IDLE), 'complete', 'only a quiet server with a new scannedAt is complete');
});

await test('butler is permanent background noise and must not keep the barrier waiting forever', () => {
  assert(!plexActivityIsLibraryWork('butler'), 'butler is not library work');
  assert(plexActivityIsLibraryWork('library.update.section'), 'a section update is');
  assert(plexActivityIsLibraryWork('library.update.item.metadata'), 'and so is item metadata');
  assert(plexActivityIsLibraryWork('media.generate.thumbnails'), 'and media generation');
  assert(!plexActivityIsLibraryWork(undefined), 'an absent type claims nothing');
  assert(!plexActivityIsLibraryWork(''), 'and neither does an empty one');
  const barrier = new PlexScanBarrier(100);
  assertEq(barrier.observe({ refreshing: false, scannedAt: 200, activities: ['butler'] }), 'complete',
    'a server whose only activity is butler has settled');
});

await test('a fast complete is a COMPLETION and is not an in-flight observation', () => {
  // A scan of a handful of entries can start and finish between two polls. That is a valid completion, and
  // it must NOT licence the mid-scan gate's claim that a publish landed while a scan was running.
  const barrier = new PlexScanBarrier(100);
  assertEq(barrier.observe(IDLE), 'complete', 'the scan ran and is over');
  assert(barrier.executionSeen, 'an execution happened');
  assert(!barrier.observedInFlight, 'but nobody saw it running, and the barrier says so');
});

await test('a stale scannedAt cannot complete a scan that has not started', () => {
  const barrier = new PlexScanBarrier(200);
  assertEq(barrier.observe({ refreshing: false, scannedAt: 200, activities: [] }), 'not-started',
    'the same timestamp we baselined on is not a new scan');
  assertEq(barrier.observe({ refreshing: false, scannedAt: 199, activities: [] }), 'not-started',
    'and neither is an older one');
});

await test('a first-ever scan completes even though there was no baseline to move past', () => {
  const barrier = new PlexScanBarrier(undefined);
  assertEq(barrier.observe({ refreshing: false, scannedAt: 10, activities: [] }), 'complete',
    'an absent baseline means the library had never been scanned, so any recorded scan is newer');
});

await test('a poll that FAILED is not an observation and claims nothing', () => {
  const barrier = new PlexScanBarrier(100);
  assertEq(barrier.observe(undefined), 'not-started', 'an unreadable server says nothing about the scan');
  assert(!barrier.executionSeen, 'and does not count as an execution');
  barrier.observe(BUSY);
  assertEq(barrier.observe(undefined), 'running', 'once seen running, an unreadable poll does not un-see it');
});

await test('a new scan under an unreadable refreshing flag is INDETERMINATE, not complete', () => {
  const barrier = new PlexScanBarrier(100);
  assertEq(barrier.observe({ scannedAt: 200 }), 'indeterminate',
    'a new scan is recorded but nothing says whether the section has settled');
  assert(barrier.executionSeen, 'the execution is seen');
  assert(!barrier.observedInFlight, 'and nothing in-flight is claimed from it');
});

await test('completion is monotonic: nothing later un-ends a finished scan', () => {
  const barrier = new PlexScanBarrier(100);
  assertEq(barrier.observe(IDLE), 'complete', 'complete');
  assertEq(barrier.observe(BUSY), 'complete', 'a later refresh is a different scan, not this one restarting');
});

// ---------------------------------------------------------------------------------------------------------
// The encoder, which on Plex can actually be measured
// ---------------------------------------------------------------------------------------------------------

function encoderSamples(offsets: ReadonlyArray<[number, number, boolean]>): PlexEncoderSample[] {
  return offsets.map(([wallSeconds, offset, throttled]) => ({
    wallMs: wallSeconds * 1_000,
    present: true,
    complete: false,
    throttled,
    maxOffsetAvailable: offset,
    videoDecision: 'transcode',
    sourceVideoCodec: TRANSCODE_SOURCE_VIDEO_CODEC,
    videoCodec: TRANSCODE_TARGET_VIDEO_CODEC,
  }));
}

await test('a throttled, paced Plex encoder is measurable and meets the floors', () => {
  // The shape measured against the pinned server, scaled to a three-hundred-second window: the offset
  // advances repeatedly, and the server reports throttling because the client is holding it back.
  const samples = encoderSamples(Array.from({ length: 38 }, (_, i) =>
    [i * 8, 16 + i * 8, i % 2 === 1] as [number, number, boolean]));
  const liveness = analysePlexEncoderLiveness(samples);
  assertEq(liveness.presentSamples, 38, 'a session existed throughout');
  assertEq(liveness.liveSamples, 38, 'and was never reported complete');
  assertEq(liveness.advances, 37, 'the encoder produced new output at every step but the first');
  assert(liveness.advances >= PLEX_ENCODER_FLOORS.MIN_OFFSET_ADVANCES, 'which clears the floor');
  assert(liveness.workingSpanSeconds >= PLEX_ENCODER_FLOORS.MIN_WORKING_SPAN_SECONDS,
    `working span ${liveness.workingSpanSeconds}s clears the floor`);
  assert(liveness.throttledSamples >= PLEX_ENCODER_FLOORS.MIN_THROTTLED_SAMPLES, 'and throttling was seen');
  assertEq(liveness.producedSpanSeconds, 296, 'the media it produced across the window');
});

await test('an encoder that raced to the end and exited FAILS the floors, which is the point of them', () => {
  // This is the Jellyfin shape: the whole file encoded in a burst, then nothing. Every decoded-output
  // assertion in the gate would still pass on it — the segments exist and decode — so if the encoder floors
  // could not tell the two apart they would be decoration.
  const burst: PlexEncoderSample[] = [
    { wallMs: 0, present: true, complete: false, throttled: false, maxOffsetAvailable: 340 },
    ...Array.from({ length: 37 }, (_, i) => ({
      wallMs: (i + 1) * 8_000, present: true, complete: true, throttled: false, maxOffsetAvailable: 340,
    })),
  ];
  const liveness = analysePlexEncoderLiveness(burst);
  assertEq(liveness.advances, 0, 'the offset never moved again');
  assertEq(liveness.throttledSamples, 0, 'and nothing was ever throttled');
  assert(liveness.advances < PLEX_ENCODER_FLOORS.MIN_OFFSET_ADVANCES, 'so the advance floor refuses it');
  assert(liveness.throttledSamples < PLEX_ENCODER_FLOORS.MIN_THROTTLED_SAMPLES,
    'and so does the throttle floor');
});

await test('an offset that goes BACKWARDS is not an advance', () => {
  const liveness = analysePlexEncoderLiveness(encoderSamples([[0, 100, true], [8, 50, true], [16, 100, true]]));
  assertEq(liveness.advances, 1, 'only the genuine increase counts');
  assertEq(liveness.producedSpanSeconds, 50, 'and the span is over what was actually reported');
});

await test('samples with no session are not counted as encoder liveness', () => {
  const liveness = analysePlexEncoderLiveness([
    { wallMs: 0, present: false },
    { wallMs: 1_000, present: false },
  ]);
  assertEq(liveness.presentSamples, 0, 'no session');
  assertEq(liveness.liveSamples, 0, 'so nothing was live');
  assertEq(liveness.advances, 0, 'and nothing advanced');
  assertEq(liveness.workingSpanSeconds, 0, 'with no span to report');
});

await test('the encoder floors sit well BELOW the measured behaviour, on purpose', () => {
  // A threshold pinned to an observed value fails on a loaded machine, and a gate that fails when nothing is
  // wrong gets disabled and then gets deleted. The probe produced four advances in ninety seconds with a
  // sixty-seven-second working span; scaled to five minutes that is roughly a dozen across two hundred and
  // fifty. The floors are eight and one hundred and twenty.
  assert(PLEX_ENCODER_FLOORS.MIN_OFFSET_ADVANCES < 13, 'the advance floor has headroom');
  assert(PLEX_ENCODER_FLOORS.MIN_WORKING_SPAN_SECONDS
    < MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS * 0.6, 'and so does the span floor');
  assert(PLEX_ENCODER_FLOORS.MIN_OFFSET_ADVANCES > 1, 'while still refusing a single burst');
});

// ---------------------------------------------------------------------------------------------------------
// The driver, against a real socket serving Plex-shaped JSON
// ---------------------------------------------------------------------------------------------------------

interface FakePlexOptions {
  readonly claimed?: boolean;
  readonly itemCount?: number;
  /** Samples the section listing walks through, one per `/library/sections` read. */
  readonly refreshingScript?: readonly boolean[];
  readonly withCheckFiles?: boolean;
  readonly prefsEcho?: boolean;
}

interface FakePlex {
  readonly base: string;
  readonly server: Server;
  readonly requests: string[];
  close(): Promise<void>;
}

const PART_BODY = Buffer.from('plex-projection-fake-media-body'.repeat(64));
const PART_SHA = createHash('sha256').update(PART_BODY).digest('hex');

async function startFakePlex(options: FakePlexOptions = {}): Promise<FakePlex> {
  const itemCount = options.itemCount ?? 3;
  const requests: string[] = [];
  let sectionReads = 0;
  const prefs = new Map<string, string>();

  const items = Array.from({ length: itemCount }, (_, index) => ({
    ratingKey: String(index + 1),
    key: `/library/metadata/${index + 1}`,
    guid: `tv.plex.agents.none://${index + 1}`,
    duration: 340_000,
    Media: [{
      videoCodec: 'mpeg4',
      container: 'mp4',
      Part: [{
        key: `/library/parts/${index + 1}/1700000000/file.mp4`,
        file: `/media/projection/Movies/Item ${index + 1}/Item ${index + 1}.mp4`,
        size: PART_BODY.length,
        container: 'mp4',
      }],
    }],
  }));

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://fake');
    requests.push(`${request.method} ${url.pathname}`);
    const json = (body: unknown, status = 200): void => {
      response.writeHead(status, { 'content-type': PLEX_ACCEPT_JSON });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === '/identity') {
      json({ MediaContainer: { machineIdentifier: 'fake-machine', version: '1.43.0', claimed: options.claimed === true } });
      return;
    }
    if (url.pathname === '/') { json({ MediaContainer: { size: 1 } }); return; }
    if (url.pathname === '/:/prefs') {
      if (request.method === 'PUT') {
        for (const [key, value] of url.searchParams) prefs.set(key, value);
        json({});
        return;
      }
      const setting = PLEX_SERVER_PREFS.map(([key, value]) => ({
        id: key, value: options.prefsEcho === false ? 'not-what-was-asked' : (prefs.get(key) ?? value),
      }));
      json({ MediaContainer: { Setting: setting } });
      return;
    }
    if (url.pathname === '/library/sections') {
      const script = options.refreshingScript;
      const refreshing = script === undefined
        ? false : (script[Math.min(sectionReads, script.length - 1)] ?? false);
      sectionReads += 1;
      json({
        MediaContainer: {
          Directory: [{
            key: '1', title: 'Projection Movies', refreshing, scannedAt: refreshing ? 100 : 900,
            agent: 'tv.plex.agents.none', scanner: 'Plex Video Files',
            Location: [{ id: 1, path: '/media/projection/Movies' }],
          }],
        },
      });
      return;
    }
    if (url.pathname === '/activities') { json({ MediaContainer: { Activity: [{ type: 'butler' }] } }); return; }
    if (url.pathname === '/library/sections/1/refresh') { json({}); return; }
    if (url.pathname === '/library/sections/1/all') {
      const start = Number(url.searchParams.get('X-Plex-Container-Start') ?? '0');
      const size = Number(url.searchParams.get('X-Plex-Container-Size') ?? '100');
      json({ MediaContainer: { size, Metadata: items.slice(start, start + size) } });
      return;
    }
    if (url.pathname.startsWith('/library/metadata/')) {
      const keys = new Set(url.pathname.slice('/library/metadata/'.length).split(','));
      const checked = url.searchParams.get('checkFiles') === '1' && options.withCheckFiles !== false;
      json({
        MediaContainer: {
          Metadata: items.filter((item) => keys.has(item.ratingKey)).map((item) => ({
            ...item,
            Media: item.Media.map((media) => ({
              ...media,
              Part: media.Part.map((part) => (checked
                ? { ...part, accessible: true, exists: true }
                : part)),
            })),
          })),
        },
      });
      return;
    }
    if (url.pathname.startsWith('/library/parts/')) {
      const range = request.headers.range;
      if (typeof range === 'string') {
        const match = /bytes=(\d+)-(\d+)/.exec(range);
        const from = Number(match?.[1] ?? 0);
        const to = Number(match?.[2] ?? PART_BODY.length - 1);
        const slice = PART_BODY.subarray(from, to + 1);
        response.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${from}-${to}/${PART_BODY.length}`,
          'content-length': String(slice.length),
        });
        response.end(slice);
        return;
      }
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(PART_BODY.length) });
      // WRITTEN IN TWO HALVES WITH A GAP, so a held-open stream test can genuinely be mid-delivery rather
      // than reading a body the socket already buffered in full.
      response.write(PART_BODY.subarray(0, PART_BODY.length / 2));
      setTimeout(() => { response.end(PART_BODY.subarray(PART_BODY.length / 2)); }, 400);
      return;
    }
    response.writeHead(404).end();
  };

  const server = createServer(handler);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

await test('a CLAIMED server is refused, because this gate is supposed to need nobody\'s account', async () => {
  const fake = await startFakePlex({ claimed: true });
  try {
    let message = '';
    try {
      await awaitServer({ baseUrl: fake.base });
    } catch (error) { message = (error as Error).message; }
    assert(/CLAIMED/.test(message), `a claimed server fails loudly, got: ${message}`);
  } finally {
    await fake.close();
  }
});

await test('an unclaimed server is accepted and its identity recorded', async () => {
  const fake = await startFakePlex();
  try {
    const outcome = await awaitServer({ baseUrl: fake.base });
    assertEq(outcome.claimed, false, 'unclaimed');
    assertEq(outcome.machineIdentifier, 'fake-machine', 'and its identity is recorded');
  } finally {
    await fake.close();
  }
});

await test('preferences that did not apply are a NAMED FAILURE, not a silent one', async () => {
  // `PUT /:/prefs` answers 200 for a preference it does not recognise, so fire-and-forget would be a check
  // that cannot fail: a renamed preference would silently stop being applied and the background job it was
  // disabling would start reading whole media files inside the amplification window.
  const fake = await startFakePlex({ prefsEcho: false });
  try {
    let message = '';
    try { await applyPreferences({ baseUrl: fake.base }); } catch (error) { message = (error as Error).message; }
    assert(/did not apply/.test(message), `a preference that did not land fails: ${message}`);
  } finally {
    await fake.close();
  }
});

await test('preferences that DID apply pass, and every one of them is checked', async () => {
  const fake = await startFakePlex();
  try {
    const applied = await applyPreferences({ baseUrl: fake.base });
    assertEq(applied, PLEX_SERVER_PREFS.length, 'all of them');
  } finally {
    await fake.close();
  }
});

await test('a listing is paged, and a library of exactly one page is not silently truncated', async () => {
  // MEASURED: Plex OMITS `totalSize` whenever the requested window covers the whole section. A pager that
  // trusted `totalSize ?? metadata.length` would be right by luck for a library of exactly one page and
  // WRONG for one page plus one — and every corpus assertion would then be made over a short listing.
  const fake = await startFakePlex({ itemCount: 100 });
  try {
    const state: GateState = { baseUrl: fake.base, sectionId: '1' };
    const items = await listMovies(state);
    assertEq(items.length, 100, 'a full page is not the end of the library by itself');
    const pageReads = fake.requests.filter((entry) => entry.endsWith('/library/sections/1/all')).length;
    assert(pageReads >= 2, `a second page was asked for, saw ${pageReads} listing requests`);
  } finally {
    await fake.close();
  }
});

await test('the ordinary-file answer comes from checkFiles=1, and its absence is a FAILURE', async () => {
  const withChecks = await startFakePlex();
  try {
    const items = await listMovies({ baseUrl: withChecks.base, sectionId: '1' });
    assert(items.every(isOrdinaryFile), 'the server stat\'ed each file and said yes');
    assert(withChecks.requests.some((entry) => entry.startsWith('GET /library/metadata/')),
      'and it was asked through the metadata endpoint, which is the only one that honours checkFiles');
  } finally {
    await withChecks.close();
  }
  const without = await startFakePlex({ withCheckFiles: false });
  try {
    const items = await listMovies({ baseUrl: without.base, sectionId: '1' });
    assert(items.every((item) => !isOrdinaryFile(item)),
      'a server that did not answer accessible/exists cannot have its items called ordinary files');
  } finally {
    await without.close();
  }
});

await test('a scan waits for the library to SETTLE, not for the refreshing flag alone', async () => {
  // The script makes `refreshing` true for the first two reads and false afterwards, and the barrier must
  // not return until it sees a settled sample with a moved `scannedAt`.
  const fake = await startFakePlex({ refreshingScript: [true, true, false] });
  try {
    const state: GateState = { baseUrl: fake.base, sectionId: '1' };
    let sawRunning = false;
    const outcome = await scanLibrary(state, () => { sawRunning = true; });
    assert(sawRunning, 'the in-flight callback fired for a genuinely running sample');
    assert(outcome.observedInFlight, 'and the barrier records the in-flight FACT');
    assertEq(outcome.items.length, 3, 'and the listing is taken after it settled');
  } finally {
    await fake.close();
  }
});

await test('direct play digests the bytes, and a range read asserts 206 before reading the body', async () => {
  const fake = await startFakePlex();
  try {
    const state: GateState = { baseUrl: fake.base, sectionId: '1' };
    const [item] = await listMovies(state);
    assert(item !== undefined, 'an item');
    const played = await directPlay(state, item as ItemRecord, PART_BODY.length);
    assertEq(played.bytes, PART_BODY.length, 'the whole file');
    assertEq(played.sha256, PART_SHA, 'byte for byte');

    const window = await rangeRead(state, item as ItemRecord, 10, 64);
    assertEq(window.status, 206, 'a ranged request answers 206');
    assertEq(window.bytes, 64, 'with exactly the window asked for');
    assertEq(window.sha256, createHash('sha256').update(PART_BODY.subarray(10, 74)).digest('hex'),
      'and the right bytes');
  } finally {
    await fake.close();
  }
});

await test('a held-open stream is ONE response read in two halves, and it knows how much arrived after', async () => {
  // TWO SEQUENTIAL REQUESTS ARE NOT A STREAM IN FLIGHT. The Jellyfin gate shipped that mistake: a prefix
  // read that drains and releases ENDS the exchange, the media server closes its file, and the daemon sees a
  // RELEASE — so what was proved was that two requests succeed either side of an event.
  const fake = await startFakePlex();
  try {
    const state: GateState = { baseUrl: fake.base, sectionId: '1' };
    const [item] = await listMovies(state);
    const stream = await openPinnedStream(state, item as ItemRecord);
    await stream.readAtLeast(1);
    const before = stream.bytesRead;
    assert(!stream.ended, 'the body has not finished, so something really is held open');
    assert(before < PART_BODY.length, 'and not everything has arrived yet');
    const result = await stream.finish();
    assertEq(result.bytes, PART_BODY.length, 'the whole body came from this one response');
    assertEq(result.sha256, PART_SHA, 'and it digests to the same thing');
    assert(result.bytes - before > 0, 'with a measurable share arriving after the pause');
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------------------------------------
// A skip is not a pass, and the wrapper accounting is run rather than read
// ---------------------------------------------------------------------------------------------------------

function runWrapper(script: string, gateStatus: number, env: Record<string, string> = {}): {
  status: number; stdout: string; stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'plex-gate-stub-'));
  const stub = join(dir, 'stub.sh');
  writeFileSync(stub, `#!/usr/bin/env bash\necho "stub run"\nexit ${gateStatus}\n`);
  chmodSync(stub, 0o755);
  const result = spawnSync('bash', [join(repoRoot, script)], {
    encoding: 'utf8',
    env: { ...process.env, PROJECTION_PLEX_GATE_COMMAND: stub, ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

await test('a skipped run propagates 77 through the three-run wrapper and closes nothing', () => {
  const result = runWrapper('deploy/projection-plex-dataplane-gate-three.sh', 77);
  assertEq(result.status, 77, 'the wrapper propagates the skip');
  assert(!/consecutive PLEX runs completed/.test(result.stdout),
    'and CANNOT emit its completion message — a green tranche-closing command that proved nothing is the '
    + 'single worst failure this repository can have');
  assert(/CLOSES NOTHING/.test(result.stderr), 'and says so');
});

await test('a failing run stops the sequence rather than averaging it', () => {
  const result = runWrapper('deploy/projection-plex-dataplane-gate-three.sh', 3);
  assertEq(result.status, 3, 'the failure propagates unchanged');
  assert(/FAILED at run 1 of 3/.test(result.stderr), 'and names the run it stopped at');
});

await test('three passing runs are counted, and the message is guarded by the COUNT', () => {
  const result = runWrapper('deploy/projection-plex-dataplane-gate-three.sh', 0);
  assertEq(result.status, 0, 'three runs pass');
  assert(/3 of 3 consecutive PLEX runs completed, none skipped/.test(result.stdout), 'and are counted');
  assert(/must not be reported as Phase 1 closure/.test(result.stdout), 'while saying what it is not');
  assert(/Emby is still untouched/.test(result.stdout), 'and naming the media server still untouched');
});

await test('a wrapper asked for zero runs refuses to announce a completed sequence', () => {
  const result = runWrapper('deploy/projection-plex-dataplane-gate-three.sh', 0, {
    PROJECTION_PLEX_GATE_RUNS: '0',
  });
  assert(result.status !== 0, 'a loop that never ran is not a completed sequence');
  assert(/refusing to report a completed sequence/.test(result.stderr), 'and it says so');
});

await test('the OPTIONAL entry point maps 77 to 0 and NOTHING else', () => {
  const skipped = runWrapper('deploy/projection-plex-dataplane-gate-optional.sh', 77);
  assertEq(skipped.status, 0, 'a skip is success for a caller that chose this entry point');
  assert(/NOTHING WAS PROVED/.test(skipped.stderr), 'while saying loudly that nothing was proved');
  const failedRun = runWrapper('deploy/projection-plex-dataplane-gate-optional.sh', 4);
  assertEq(failedRun.status, 4, 'a real failure is still a failure here');
});

// ---------------------------------------------------------------------------------------------------------
// The gate script itself
// ---------------------------------------------------------------------------------------------------------

const GATE = read('deploy/projection-plex-dataplane-gate.sh');

await test('the gate exits 77 rather than 0 when the host cannot host it', () => {
  assert(GATE.includes('GATE_SKIP_STATUS=77'), 'the skip status is 77');
  assert(GATE.includes('exit "$GATE_SKIP_STATUS"'), 'and it exits with it');
  assert(!/exit 0\s*$/m.test(GATE.split('step "checking this host')[1]?.split('step "building')[0] ?? ''),
    'nothing in the host check exits 0');
});

await test('the gate uses NOBODY\'S Plex account', () => {
  assert(!/PLEX_CLAIM/.test(GATE.replace(/^#.*$/gm, '')),
    'no claim token is ever passed to the container');
  assert(GATE.includes('PlexOnlineToken'), 'and the run asserts none was written to disk');
  assert(/no plex.tv token and no account address/.test(GATE), 'and says what it checked');
});

await test('the media server image and every other external image is pinned by digest', () => {
  for (const variable of ['PLEX_IMAGE', 'DECODER_IMAGE', 'GO_IMAGE', 'VERIFY_IMAGE']) {
    const line = GATE.split('\n').find((entry) => entry.startsWith(`${variable}=`)) ?? '';
    assert(/@sha256:[0-9a-f]{64}/.test(line), `${variable} is pinned by digest, not by tag: ${line}`);
  }
  const compose = read('docker-compose.projection-plex.yml');
  assert(/image: postgres:16@sha256:[0-9a-f]{64}/.test(compose), 'and so is the database');
});

await test('the decoder is NOT the server under test, and the gate says why', () => {
  assert(!GATE.includes('DECODER_IMAGE="plexinc'), 'the decoder does not come from the Plex image');
  assert(/Plex image ships no|ships only `Plex Transcoder`|NO ffprobe/i.test(GATE),
    'and the gate records that the Plex image has no ffprobe at all');
  assert(GATE.includes('$DECODER_FFPROBE'), 'every probe uses the independent one');
  assert(!GATE.includes('Plex Transcoder'.concat('" ')), 'and nothing invokes the server\'s own encoder');
});

await test('the mount is deliberately NOT bound read-only, so the DAEMON is what refuses a write', () => {
  assert(GATE.includes('-v "$WORK/mnt:/media/projection:rslave"'), 'the mount is bound');
  assert(!GATE.includes('/media/projection:ro'), 'and never read-only');
  assert(/mutate.sh/.test(GATE), 'and the mutation attempts run inside the media server\'s own container');
  assert(/docker exec -i --user 1000:1000/.test(GATE), 'as its own non-root uid');
});

await test('the media server is asserted to be non-root rather than assumed', () => {
  assert(/PLEX_PROC_USER/.test(GATE), 'the process owner is read');
  assert(/!= "root"/.test(GATE), 'and refused if it is root');
});

await test('every remount is followed by a BYTE READ from inside the media server\'s own container', () => {
  // THE DEFECT THIS CLOSES, found by a real failure in the Jellyfin gate: a container started BEFORE a
  // daemon restart can hold a dead FUSE mount whose `stat` still answers and whose `open` returns ENOTCONN.
  // A scan across that reports ZERO REMOVALS, because declining to delete a library whose root has gone
  // unreadable is correct scanner behaviour — so every churn assertion would pass on a dead mount.
  assert(/head -c 65536 '\/media\/projection\//.test(GATE), 'bytes are read, not metadata');
  const afterRemount = GATE.split('restarting and remounting')[1] ?? '';
  const readIndex = afterRemount.indexOf('head -c 65536');
  const churnIndex = afterRemount.indexOf('--gate PX11-recovery');
  assert(readIndex > 0 && churnIndex > readIndex,
    'and the read happens BEFORE any churn assertion, so a dead mount fails at the point it happened');
});

await test('the mid-scan window is made deterministic by a HOLD, not by a sleep', () => {
  // SLICED TO THE STEP, not to everything after it. A slice that ran to the end of the file would sweep in
  // the provider-restart loop's `sleep 1` and the "no bare sleep" assertion would fail for a reason that has
  // nothing to do with the mid-scan handshake.
  const midscan = (GATE.split('a generation admitted WHILE A SCAN IS RUNNING')[1] ?? '')
    .split('step "a source outage')[0] ?? '';
  assert(midscan.includes('/control/hold/'), 'a provider read is held');
  assert(midscan.includes('currentHeldWaiters'),
    'and the LIVE gauge is what licenses the claim, not the lifetime counter, which stays up after a hold '
    + 'lapses and the request proceeds');
  assert(midscan.includes('holdTimeouts'), 'a hold that lapsed inside the window is a failure');
  assert((midscan.match(/assert-scan-in-flight/g) ?? []).length >= 2,
    'both edges of the window are observed: running before the publish and still running after it');
  assert(!/^\s*sleep 1\s*$/m.test(midscan), 'and nothing in the handshake is a bare sleep');
});

await test('the raced scan\'s result is RECORDED, and the convergence is what is asserted', () => {
  const midscan = GATE.split('a generation admitted WHILE A SCAN IS RUNNING')[1] ?? '';
  assert(midscan.includes('--tolerant true'), 'the raced scan is tolerant');
  assert(midscan.includes('--gate PX16-midscan-swap'), 'and the NEXT scan is the one compared');
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  assert(cli.includes('raced-scan-completed'), 'the tolerant path records what it saw');
  assert(cli.includes('raced-item-coherent'), 'and refuses anything half-formed');
});

await test('the corpus is fifty entries and its self-consistency is asserted before Plex sees it', () => {
  assert(/CORPUS_COUNT=47/.test(GATE), 'forty-seven generated');
  assert(/--min-entries 50/.test(GATE), 'plus the anchors and the soak source: fifty');
  assert(/--min-remote 39/.test(GATE), 'most of them served over HTTP Range');
  assert(/corpus-check/.test(GATE), 'and the corpus is checked against itself first');
});

await test('the report is redaction-checked before it is printed, and a SKIP fails the report', () => {
  assert(GATE.includes('drive redaction-check --file'), 'the results file is checked');
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  assert(/if \(skipped\.length > 0\) process\.exit\(1\)/.test(cli),
    'a run with a skipped assertion has not proved what its gate id says, and exits non-zero');
  assert(/if \(failed\.length > 0\) process\.exit\(1\)/.test(cli), 'and so does a failed one');
});

await test('every wait in the driver takes a bounded deadline from the shared contract', () => {
  const driver = read('src/ops/projection-plex-dataplane.ts');
  // COMMENTS ARE STRIPPED FIRST. The driver's own header names the wrong spelling in order to explain why it
  // is wrong, and a check that fired on the explanation would force the explanation out of the file — which
  // is how a hard-won finding gets deleted by a test that was trying to protect it.
  const code = driver.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  assert(!/while \(true\)/.test(code), 'no unbounded loop');
  assert(!/signal:\s*AbortSignal\.timeout/.test(code),
    'and never AbortSignal.timeout, whose timer is UNREF\'D — a fetch behind it can let Node exit 0 with '
    + 'nothing done, which is how a phase "passes" having proved nothing');
  assert(/new AbortController\(\)/.test(driver), 'the watchdog is an explicit controller');
  assert(/setTimeout\(\(\) => \{ timedOut = true; controller\.abort\(\); \}, timeoutMs\)/.test(driver),
    'behind an ordinary ref\'d timer');
  for (const deadline of Object.values(MEDIA_SERVER_DEADLINES_MS)) {
    assert(Number.isFinite(deadline) && deadline > 0, 'every shared deadline is a finite positive number');
  }
});

await test('a phase that ends without saying so is a failure rather than a silent zero', () => {
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  assert(/const keepalive = setInterval/.test(cli), 'the event loop is held open while a phase runs');
  assert(/the phase exited without completing/.test(cli), 'and an exit that happens anyway is named');
});

await test('the gate\'s scratch directory is ignored, and no host path is handed to docker cp', () => {
  assert(read('.gitignore').includes('.projection-plex-gate/'), 'the scratch directory is git-ignored');
  assert(GATE.includes('GATE_ROOT="$PWD/.projection-plex-gate"'), 'it lives beside the repository');
  assert(!/^\s*docker cp /m.test(GATE), 'nothing hands a host path to docker cp');
});

await test('the gate cleans up after itself, media server first', () => {
  const cleanup = GATE.split('cleanup() {')[1]?.split('trap cleanup EXIT')[0] ?? '';
  assert(cleanup.indexOf('$PLEX_CONTAINER') < cleanup.indexOf('$MOUNT_CONTAINER'),
    'the media server is removed before the daemon: a FUSE mount with a live reader does not unmount '
    + 'cleanly, and a stale one is how the NEXT run passes for the wrong reason');
  assert(cleanup.includes('umount -l'), 'and a lazy unmount catches whatever is left');
  assert(GATE.includes('trap cleanup EXIT'), 'cleanup runs on success and on failure');
});

await test('the gate does not collide with any other gate on this machine', () => {
  const plexCompose = read('docker-compose.projection-plex.yml');
  assert(plexCompose.includes('name: projection-plex-gate'), 'its own compose project');
  assert(plexCompose.includes('5490'), 'its own database port');
  const jellyfinCompose = read('docker-compose.projection-jellyfin.yml');
  assert(!jellyfinCompose.includes('5490'), 'which the Jellyfin gate does not use');
  assert(GATE.includes('NETWORK="projection-plex-gate"'), 'and its own network');
  assert(GATE.includes('RANGE_PORT="${PROJECTION_PLEX_GATE_RANGE_PORT:-8095}"'), 'and its own endpoint port');
});

// ---------------------------------------------------------------------------------------------------------
// Wiring and documentation
// ---------------------------------------------------------------------------------------------------------

await test('package, inventory and the aggregate run are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-plex-dataplane'], 'tsx test/projection-plex-dataplane.ts',
    'test script');
  assertEq(pkg.scripts['go:plex-dataplane-gate'], 'bash deploy/projection-plex-dataplane-gate.sh', 'gate');
  assertEq(pkg.scripts['go:plex-dataplane-gate:three'],
    'bash deploy/projection-plex-dataplane-gate-three.sh', 'three-run wrapper');
  assertEq(pkg.scripts['go:plex-dataplane-gate:optional'],
    'bash deploy/projection-plex-dataplane-gate-optional.sh', 'optional entry point');
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-plex-dataplane.ts'), 'suite in npm test');
  assert(!(AGGREGATE_SUITE_COMMAND ?? '').includes('docker'), 'the aggregate suite needs no Docker');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as {
    suites: Array<{ file: string; group: string }>;
  };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-plex-dataplane.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry?.group, 'offline', 'and needs no database');
});

await test('the Plex document states the limits in the same breath as the capability', () => {
  const doc = read('docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md');
  for (const limit of ['Emby', 'Unraid', 'TorBox', 'G18', 'G22']) {
    assert(doc.includes(limit), `the doc names ${limit} among what is not yet proved`);
  }
  assert(/Docker Desktop/.test(doc), 'the doc names the environment it has actually been run in');
  assert(/not Phase 1 closure/i.test(doc) && /SHALL NOT be reported as one/.test(doc),
    'and says plainly that a run there is not closure');
  assert(/three consecutive/i.test(doc), 'and repeats what passing means');
});

await test('the Plex document records the plex.tv dependency instead of hiding it', () => {
  assert(PLEX_UNCLAIMED_LOCAL_API_REQUIRES_PLEX_TV_REACHABILITY,
    'the contract records the dependency as a fact');
  const doc = read('docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md');
  assert(/plex\.tv/.test(doc), 'the document names plex.tv');
  assert(/401/.test(doc), 'and what happens without it');
  assert(/internal/.test(doc), 'and how that was measured');
  assert(/no Plex account|nobody's Plex account|unclaimed/i.test(doc),
    'while stating that no account is used');
});

await test('the Plex document does not copy the Jellyfin gate\'s claims', () => {
  const plex = read('docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md');
  // The Jellyfin findings MAY be named here — the contrast is the most useful thing this document has to
  // say — but each must be ATTRIBUTED, never inherited. A Jellyfin measurement presented as a Plex one would
  // be exactly the borrowing this test exists to refuse.
  for (const borrowed of ['PlayState.PlayMethod', '1.6 seconds', '1.6\n  seconds']) {
    let from = plex.indexOf(borrowed);
    while (from !== -1) {
      const window = plex.slice(Math.max(0, from - 700), from + 700);
      assert(/Jellyfin/.test(window), `"${borrowed}" appears with no mention of Jellyfin anywhere near it`);
      from = plex.indexOf(borrowed, from + 1);
    }
  }
  assert(plex.includes('PLEX_HAS_NO_CLIENT_WRITABLE_PLAY_METHOD') || /no client-writable/i.test(plex),
    'and the document states the Plex fact rather than inheriting the Jellyfin one');
  assert(/throttl/i.test(plex), 'and the Plex encoder behaviour is described in its own terms');
});

await test('the acceptance plan records Plex as run WITHOUT recording Phase 1 as closed', () => {
  const plan = read('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');
  assert(plan.includes('plex-dataplane-gate'), 'the plan names the gate that now runs');
  assert(/Emby/.test(plan), 'Emby is still named as untouched');
  const row = (gate: string): string =>
    (plan.split('\n').find((line) => line.startsWith(`| ${gate} `)) ?? '').trim();
  for (const gate of ['G7 **Scan**', 'G8 **Play**', 'G9 **Seek**', 'G10 **Transcode**']) {
    assert(/\| not run \|$/.test(row(gate)), `${gate} still records EMBY as not run: ${row(gate)}`);
  }
  assert(/G18/.test(plan) && /not run/.test(plan), 'G18 is still not run');
});

await test('the roadmap records a second media server without declaring the tranche closed', () => {
  const roadmap = read('docs/PROJECTION_ROADMAP.md');
  assert(/Phase 1 remains open|Phase 1 is open|\*\*Open\.\*\*/.test(roadmap), 'the tranche is still open');
  assert(/has not been satisfied/.test(roadmap), 'and the anti-detour rule says it is not satisfied');
  assert(roadmap.includes('Emby'), 'Emby is named among what has not happened');
  assert(roadmap.includes('Unraid'), 'and so is Unraid');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`\n${name}\n  ${(error as Error).stack ?? error}`);
  process.exit(1);
}
