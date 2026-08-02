import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  MEDIA_SERVER_BUDGETS, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_SOAK, SEEK_PLAN_FRACTIONS,
  TRANSCODE_SOURCE_VIDEO_CODEC,
  TRANSCODE_TARGET_VIDEO_CODEC, findRedactionProblems, seekPlanProblems,
} from '../src/core/projection/media-server-dataplane.js';
import {
  PLEX_ACCEPT_JSON, PLEX_CLIENT, PLEX_ENCODER_FLOORS, PLEX_HAS_NO_CLIENT_WRITABLE_PLAY_METHOD, PLEX_LIBRARY,
  PLEX_AIR_GAPPED_TESTED_PATHS, PLEX_LARGE_FIXTURE, PLEX_READ_GEOMETRY,
  PLEX_REJECTS_UNRECOGNISED_HOST_HEADER, PLEX_SEEK_IS_AN_OFFSET_RESTART,
  PLEX_SEGMENT_CONTAINER, PLEX_SERVER_PREFS, plexScanByteCeiling, plexSeekByteCeiling,
  PLEX_UNCLAIMED_LOCAL_API_REQUIRES_PLEX_TV_REACHABILITY,
  PlexScanBarrier, analysePlexEncoderLiveness, parsePlexVariantPlaylist, plexActivityIsLibraryWork,
  plexClientQuery, plexCreateSectionPath, plexDirectPlayPath, plexHasQueryCredential, plexIsStartingUp,
  plexPartIsOrdinaryFile, plexPrefsPath, plexSeekPositionErrorCeilingSeconds, plexSegmentPath,
  plexSegmentPlanFor, plexStripQueryCredentials, plexTranscodePingPath, plexTranscodeStartPath,
  plexTranscodeStopPath, plexVariantPlaylistPath,
  type PlexEncoderSample, type PlexScanSample,
} from '../src/core/projection/plex-dataplane.js';
import {
  addMovieLibrary, applyPreferences, awaitServer, directPlay, isOrdinaryFile, listMovies,
  mediaTimeSeekSet, openPinnedStream, rangeRead, scanLibrary, withoutLocators,
  type GateState, type ItemRecord,
} from '../src/ops/projection-plex-dataplane.js';

// Projection Phase 1 — the offline half of the PLEX data-plane gate.
//
// WHAT THIS SUITE IS FOR. The gate itself needs Docker, /dev/fuse, a real PostgreSQL and a real Plex, and it
// takes half an hour. This suite runs everywhere, in seconds, and holds the rules the gate depends on: that
// every wait is bounded, that a skipped run cannot look like a passing one, that the request shapes carry no
// credential, that the scan barrier and the held-open stream BEHAVE as claimed, and that the report cannot
// leak.
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

// Read once, up here, because several sections below assert against the gate script.
const GATE = read('deploy/projection-plex-dataplane-gate.sh');

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

await test('a SEEK is an offset restart, and the driver performs it as one', () => {
  // THE MECHANISM THIS REPLACES WEDGED, AND IT WEDGED WITH NOTHING OF THIS PRODUCT INVOLVED. Against a
  // purely local file, one session and out-of-order segment GETs in the gate's own seek order answered the
  // first six in ~150ms each and then took 45s and timed out. Two gate runs were lost before the mechanism
  // was suspected rather than the data plane. The same ten positions through the offset restart: ~300ms each.
  assert(PLEX_SEEK_IS_AN_OFFSET_RESTART, 'the contract records the mechanism');
  assert(plexTranscodeStartPath('/library/metadata/1', 's').includes('offset=0'), 'the default is zero');
  assert(plexTranscodeStartPath('/library/metadata/1', 's', 139.4).includes('offset=139.4'),
    'and a seek names the position it wants');
  assertEq(PLEX_SEGMENT_CONTAINER, 'mpegts', 'the segments are transport streams');

  const driver = read('src/ops/projection-plex-dataplane.ts');
  const seekSet = driver.split('export async function mediaTimeSeekSet')[1]?.split('\nexport ')[0] ?? '';
  assert(/openTranscodeSession\(state, item, session, wanted\)/.test(seekSet),
    'every seek re-issues start.m3u8 at the position it wants');
  assert(/plexSegmentPlanFor\(atOffset\.entries, wanted\)/.test(seekSet),
    'and plans from the playlist the server returned for THAT offset, not a cached one');
  // AND THE ELAPSED TIME COVERS THE WHOLE SEEK. Timing only the final GET would hide the encoder restart
  // that the seek actually consists of, and the ten-second contract would be measuring the cheap half.
  assert(/const startedAt = now\(\);/.test(seekSet), 'the clock starts before the offset request');
  assert(/const elapsedMs = now\(\) - startedAt;/.test(seekSet), 'and stops after the segment arrives');
  assert(!/elapsedMs: fetched\.elapsedMs/.test(seekSet), 'never just the segment fetch');
  // AND THE COMPLETED SEEKS SURVIVE A MID-SET THROW. The profile used to be written only on return, so a
  // timeout on seek six left no timings for the five that had worked.
  assert(/process\.stdout\.write\(`    seek \$\{index\}/.test(seekSet),
    'each seek announces itself on both edges, so a throw still leaves the completed ones on stdout');
  assert(/credentialsInGeneratedUrls \+= atOffset\.credentialsInGeneratedUrls/.test(seekSet),
    'and every offset restart\'s generated playlists are checked for a credential, not just the first');
});

await test('the ten-second seek contract survived the mechanism change unweakened', () => {
  // The failure mode this refuses is the tempting one: a mechanism that times out, "fixed" by widening the
  // budget until it passes. Every threshold G9 rests on is unchanged.
  assertEq(MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS, 10, 'ten seconds per seek');
  assertEq(MEDIA_SERVER_SOAK.SEEK_COUNT, 10, 'ten seeks');
  assertEq(MEDIA_SERVER_SOAK.MIN_BACKWARD_SEEKS, 3, 'at least three backwards');
  assertEq(MEDIA_SERVER_SOAK.MAX_SEEK_DECODED_OFFSET_SPREAD_SECONDS, 1.5, 'the temporal check is unchanged');
  assertEq(MEDIA_SERVER_SOAK.MIN_SEEK_DECODED_SPAN_FRACTION, 0.8, 'and so is the span');
  assert(Number.isFinite(MEDIA_SERVER_DEADLINES_MS.SEEK) && MEDIA_SERVER_DEADLINES_MS.SEEK <= 60_000,
    'and the per-seek wait is still bounded well under a minute');
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

await test('a scan seen RUNNING and then quiet completes, even if scannedAt never moved', () => {
  // THE HANG THIS CLOSES. Completion used to require a moved `scannedAt`, and Plex does not promise to move
  // it for a refresh that changed nothing. A scan this observer watched run and watched go quiet is
  // finished, whatever the timestamp says — and the old rule would have waited out the full 300s deadline
  // on a library that had demonstrably settled, reading as a slow scanner rather than a barrier that could
  // not recognise the end.
  const barrier = new PlexScanBarrier(100);
  assertEq(barrier.observe({ refreshing: true, scannedAt: 100, activities: ['library.update.section'] }),
    'running', 'the scanner is seen running, with the baseline timestamp unchanged');
  assertEq(barrier.observe({ refreshing: false, scannedAt: 100, activities: ['butler'] }), 'complete',
    'and going quiet at the SAME timestamp is completion');
  assert(barrier.observedInFlight, 'the in-flight fact is what licensed it');
});

await test('...but quiet at the same timestamp with nothing ever seen running is NOT completion', () => {
  // The other half, and the reason the disjunct is guarded by the in-flight fact rather than dropped.
  const barrier = new PlexScanBarrier(100);
  assertEq(barrier.observe({ refreshing: false, scannedAt: 100, activities: ['butler'] }), 'not-started',
    'a server that was always quiet has not scanned');
  assert(!barrier.executionSeen, 'and no execution is claimed');
  assert(!barrier.observedInFlight, 'nor any in-flight observation');
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
  /**
   * What `POST /library/sections` answers, one entry per attempt; the LAST entry repeats forever.
   *
   * It exists because the first real run of this gate died on a refusal that only the body identified, and
   * a fix for that has to be shown to retry the transient one and to NOT retry anything else.
   */
  readonly sectionPostScript?: ReadonlyArray<{ readonly status: number; readonly body: string }>;
  /** Put an `X-Plex-Token` into generated playlists once the requested offset reaches this. */
  readonly tokenFromOffset?: number;
  /** Make this segment index answer 500, so a mid-set throw can be driven. */
  readonly failSegment?: number;
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
  let sectionPosts = 0;
  let sectionCreated = false;
  let lastOffset = 0;
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
      if (request.method === 'POST') {
        const script = options.sectionPostScript;
        const step = script === undefined
          ? { status: 201, body: '' }
          : (script[Math.min(sectionPosts, script.length - 1)] ?? { status: 201, body: '' });
        sectionPosts += 1;
        if (step.status >= 200 && step.status < 300) sectionCreated = true;
        response.writeHead(step.status, { 'content-type': 'text/plain' });
        response.end(step.body);
        return;
      }
      const script = options.refreshingScript;
      const refreshing = script === undefined
        ? false : (script[Math.min(sectionReads, script.length - 1)] ?? false);
      sectionReads += 1;
      // WITH A POST SCRIPT, THE SECTION DOES NOT EXIST UNTIL ONE SUCCEEDS. Otherwise `addMovieLibrary`
      // finds it already there and never posts at all, and the retry behaviour under test never runs.
      const exists = options.sectionPostScript === undefined || sectionCreated;
      json({
        MediaContainer: {
          Directory: exists ? [{
            key: '1', title: 'Projection Movies', refreshing, scannedAt: refreshing ? 100 : 900,
            agent: 'tv.plex.agents.none', scanner: 'Plex Video Files',
            Location: [{ id: 1, path: '/media/projection/Movies' }],
          }] : [],
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
    // The transcode surface, only as far as the seek set needs it: a master playlist, a variant playlist and
    // segments. `tokenFromOffset` puts a credential into the generated playlist from a given offset onward,
    // and `failSegment` makes one segment refuse — both so the seek set can be driven into the cases that
    // matter and would otherwise need a real Plex.
    if (url.pathname === '/video/:/transcode/universal/start.m3u8') {
      lastOffset = Number(url.searchParams.get('offset') ?? '0');
      const token = options.tokenFromOffset !== undefined && lastOffset >= options.tokenFromOffset
        ? '?X-Plex-Token=leaked' : '';
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsession/s/base/index.m3u8${token}\n`);
      return;
    }
    if (/\/video\/:\/transcode\/universal\/session\/.*\/base\/index\.m3u8$/.test(url.pathname)) {
      const token = options.tokenFromOffset !== undefined && lastOffset >= options.tokenFromOffset
        ? '?X-Plex-Token=leaked' : '';
      const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:8'];
      for (let index = 0; index < 43; index += 1) lines.push('#EXTINF:8,', `${String(index).padStart(5, '0')}.ts${token}`);
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(`${lines.join('\n')}\n`);
      return;
    }
    if (/\/video\/:\/transcode\/universal\/session\/.*\/base\/\d+\.ts$/.test(url.pathname)) {
      const index = Number(/(\d+)\.ts$/.exec(url.pathname)?.[1] ?? '0');
      if (options.failSegment === index) { response.writeHead(500).end(); return; }
      response.writeHead(200, { 'content-type': 'video/mp2t' });
      response.end(Buffer.from(`segment-${index}`.padEnd(256, 'x')));
      return;
    }
    if (url.pathname.startsWith('/video/:/transcode/universal/')) { response.writeHead(200).end(); return; }
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

// ---------------------------------------------------------------------------------------------------------
// "The server is still starting up" — the one refusal that means "not yet"
// ---------------------------------------------------------------------------------------------------------

const STARTING_UP_BODY = 'the server is still starting up. Please retry later';

await test('"still starting up" is recognised by the SENTENCE, never by the status alone', () => {
  assert(plexIsStartingUp(400, STARTING_UP_BODY), 'the measured 400 is retryable');
  assert(plexIsStartingUp(400, `<html>${STARTING_UP_BODY.toUpperCase()}</html>`), 'case does not hide it');
  assert(plexIsStartingUp(503, STARTING_UP_BODY), 'and so is the same sentence behind a 503');
  // EVERY OTHER 400 IS A REAL REFUSAL. Retrying on the status would swallow an agent that does not exist, a
  // scanner that does not exist, or a location the server cannot see — and turn each into a two-minute wait
  // ending in a timeout with the real reason discarded.
  assert(!plexIsStartingUp(400, 'Unknown agent tv.plex.agents.nope'), 'an unknown agent is not "not yet"');
  assert(!plexIsStartingUp(400, ''), 'and neither is a 400 with nothing to say');
  assert(!plexIsStartingUp(401, STARTING_UP_BODY), 'nor is an unauthorized answer, whatever it says');
  assert(!plexIsStartingUp(200, STARTING_UP_BODY),
    'and a SUCCESS whose payload happens to contain the phrase is not a refusal at all');
});

await test('a library creation waits out "still starting up" and then succeeds', async () => {
  // THE FIRST REAL RUN OF THIS GATE DIED HERE. /identity answered, / answered, PUT /:/prefs answered and
  // every preference read back correctly — and then the first WRITE came back 400 "still starting up".
  const fake = await startFakePlex({
    sectionPostScript: [
      { status: 400, body: STARTING_UP_BODY },
      { status: 400, body: STARTING_UP_BODY },
      { status: 201, body: '' },
    ],
  });
  try {
    const state: GateState = { baseUrl: fake.base };
    await addMovieLibrary(state, '/media/projection/Movies', 'Projection Movies', 20_000);
    assertEq(state.sectionId, '1', 'the library exists afterwards');
    const posts = fake.requests.filter((entry) => entry === 'POST /library/sections').length;
    assertEq(posts, 3, 'it retried exactly until the server accepted');
  } finally {
    await fake.close();
  }
});

await test('ANY OTHER 400 is fatal on the FIRST attempt, with the server\'s own reason kept', async () => {
  const fake = await startFakePlex({
    sectionPostScript: [{ status: 400, body: 'Unknown scanner: Plex Video Filez' }],
  });
  try {
    let message = '';
    try {
      await addMovieLibrary({ baseUrl: fake.base }, '/media/projection/Movies', 'Projection Movies', 20_000);
    } catch (error) { message = (error as Error).message; }
    assert(/Unknown scanner/.test(message), `the server's reason survives: ${message}`);
    assert(!/deadline/.test(message), 'and it is not reported as a timeout');
    const posts = fake.requests.filter((entry) => entry === 'POST /library/sections').length;
    assertEq(posts, 1, 'it did NOT retry a real refusal — one attempt, then the failure');
  } finally {
    await fake.close();
  }
});

await test('a server that never finishes starting up ends at a BOUNDED deadline', async () => {
  const fake = await startFakePlex({ sectionPostScript: [{ status: 400, body: STARTING_UP_BODY }] });
  try {
    const startedAt = Date.now();
    let message = '';
    try {
      await addMovieLibrary({ baseUrl: fake.base }, '/media/projection/Movies', 'Projection Movies', 3_000);
    } catch (error) { message = (error as Error).message; }
    const elapsed = Date.now() - startedAt;
    assert(/deadline exceeded/.test(message), `it ends by deadline, not by luck: ${message}`);
    assert(/still starting up/.test(message), 'and says what it was waiting for');
    assert(elapsed < 20_000, `and it really ended, in ${elapsed}ms`);
  } finally {
    await fake.close();
  }
});

await test('the retry budget defaults to the shared bootstrap deadline, so the seam is not a hole', () => {
  // A seam that let a caller pass Infinity would be a bound in name only. The default is the shared
  // constant, and the shared constant is finite.
  const driver = read('src/ops/projection-plex-dataplane.ts');
  assert(/budgetMs: number = MEDIA_SERVER_DEADLINES_MS\.BOOTSTRAP/.test(driver),
    'the default is the shared bootstrap deadline');
  assert(Number.isFinite(MEDIA_SERVER_DEADLINES_MS.BOOTSTRAP) && MEDIA_SERVER_DEADLINES_MS.BOOTSTRAP > 0,
    'and that deadline is finite and positive');
  const gate = read('deploy/projection-plex-dataplane-gate.sh');
  assert(!/--budget/.test(gate), 'and the gate never overrides it');
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
// The seek set, driven against a socket: late-offset credentials, and evidence that survives a throw
// ---------------------------------------------------------------------------------------------------------

const SEEK_ITEM: ItemRecord = {
  key: 'Soak.mp4', ratingKey: '1', guid: 'tv.plex.agents.none://1', metadataKey: '/library/metadata/1',
  partKey: '/library/parts/1/1/file.mp4', path: '/media/projection/Movies/Soak/Soak.mp4',
  sizeBytes: 1_000, container: 'mp4', videoCodec: 'mpeg4', accessible: true, exists: true,
  durationSeconds: 340,
};

/** Run something with `process.stdout.write` captured, so what a phase PRINTS can be asserted. */
async function capturingStdout<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: Error; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = '';
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    out += chunk; return true;
  };
  try {
    return { value: await fn(), out };
  } catch (error) {
    return { error: error as Error, out };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

await test('a credential appearing only in a LATE offset playlist is still caught', async () => {
  // THE GAP THIS CLOSES. `credentialsInGeneratedUrls` came from the session the set opened with, and every
  // seek re-issues start.m3u8 and gets a FRESH master and variant playlist back. Ten generated playlists
  // went unexamined, so a token that appeared only once the offsets got large would have gone unseen.
  const fake = await startFakePlex({ tokenFromOffset: 200 });
  try {
    const outcome = await mediaTimeSeekSet({ baseUrl: fake.base, sectionId: '1' }, SEEK_ITEM, 'sess',
      [10, 20, 300]);
    assert(outcome.credentialsInGeneratedUrls > 0,
      'the token in the third seek\'s playlist is counted, though the first two were clean');
  } finally {
    await fake.close();
  }
});

await test('a clean run over all ten offset sessions still reports zero credentials', () => {
  // The other half: a counter that always fires is as useless as one that never does.
  return startFakePlex().then(async (fake) => {
    try {
      const outcome = await mediaTimeSeekSet({ baseUrl: fake.base, sectionId: '1' }, SEEK_ITEM, 'sess',
        [10, 20, 300]);
      assertEq(outcome.credentialsInGeneratedUrls, 0, 'nothing to strip anywhere');
    } finally {
      await fake.close();
    }
  });
});

await test('a seek that throws mid-set still leaves the completed seeks as evidence', async () => {
  // THE DEFECT THIS CLOSES. The per-seek profile was recorded only after the function returned, so when seek
  // six timed out the function returned nothing, the profile was never written, and the cleanup trap deleted
  // the run directory and the media server's logs. A thirty-minute run left one line saying a segment had
  // timed out and no timings for the five seeks that had worked. A source-presence check cannot prove this;
  // driving the throw can.
  const fake = await startFakePlex({ failSegment: 37 });
  try {
    const captured = await capturingStdout(() =>
      mediaTimeSeekSet({ baseUrl: fake.base, sectionId: '1' }, SEEK_ITEM, 'sess', [10, 20, 300]));
    assert(captured.error !== undefined, 'the failing seek still fails the phase');
    assert(/seek 0 -> server position 8s, \d+ms/.test(captured.out),
      `the first completed seek is on stdout before the throw: ${captured.out}`);
    assert(/seek 1 -> server position 16s/.test(captured.out), 'and so is the second');
    assert(/seek 2 -> position 300s: requesting/.test(captured.out),
      'and the one that failed is named as attempted, so the gap is visible');
    assert(!/:\/\//.test(captured.out), 'and none of it carries a locator');
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------------------------------------
// The failure diagnostic, which must not become the failure
// ---------------------------------------------------------------------------------------------------------

function runLogTail(dockerStub: string, timeoutSeconds: string, lines = '40', maxBytes?: string): {
  status: number; stdout: string; elapsedMs: number;
} {
  const startedAt = Date.now();
  const result = spawnSync('bash',
    [join(repoRoot, 'deploy/projection-plex-log-tail.sh'), 'container', lines], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PROJECTION_PLEX_LOG_TAIL_DOCKER: dockerStub,
        PROJECTION_PLEX_LOG_TAIL_TIMEOUT_SECONDS: timeoutSeconds,
        ...(maxBytes === undefined ? {} : { PROJECTION_PLEX_LOG_TAIL_MAX_BYTES: maxBytes }),
      },
    });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', elapsedMs: Date.now() - startedAt };
}

function writeStub(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'plex-logtail-'));
  const stub = join(dir, 'docker');
  writeFileSync(stub, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(stub, 0o755);
  return stub;
}

await test('a HANGING log collector is cut off, and never becomes the failure itself', () => {
  // THE DEFECT THIS CLOSES. The first version wrapped `docker exec` in nothing while its comment claimed to
  // be bounded — and `docker exec` blocks indefinitely against a wedged container, which is exactly the
  // situation in which a gate most needs its log tail. A diagnostic that hangs there replaces an explained
  // failure with an unexplained one.
  const hanging = writeStub('sleep 60');
  const result = runLogTail(hanging, '2');
  assertEq(result.status, 0, 'the collector still exits 0, so it cannot change the gate\'s own verdict');
  assert(result.elapsedMs < 20_000, `and it returns promptly, in ${result.elapsedMs}ms`);
  assert(/could not be collected within 2s/.test(result.stdout), 'saying the bound fired');
  assert(/failure above stands on its own/.test(result.stdout),
    'and pointing back at the failure that mattered');
});

await test('the log tail scrubs tokens and query credentials, not just whole locators', () => {
  // The URL rule alone would miss a bare `?X-Plex-Token=...` fragment, and Plex logs those. Nothing reaches
  // stdout unscrubbed: the raw text is never printed, only the output of the pipeline.
  const leaky = writeStub(String.raw`printf '%s\n' "GET /library?X-Plex-Token=SECRETVALUE from 172.22.0.4" `
    + String.raw`"opening https://example.test/x?api_key=OTHERSECRET" `
    + String.raw`"file /config/Library/Plex.log and /media/projection/Movies/a.mp4"`);
  const result = runLogTail(leaky, '15');
  assertEq(result.status, 0, 'it collects');
  assert(!/SECRETVALUE/.test(result.stdout), 'the Plex token value is gone');
  assert(!/OTHERSECRET/.test(result.stdout), 'and so is an api_key value');
  assert(!/172\.22\.0\.4/.test(result.stdout), 'and the address');
  assert(!/:\/\//.test(result.stdout), 'and the locator');
  assert(!/\/config\/Library/.test(result.stdout) && !/\/media\/projection\/Movies/.test(result.stdout),
    'and both filesystem paths');
  assert(/GET \/library/.test(result.stdout), 'while the part worth reading survives');
});

await test('a collector that fails outright says so, without pretending it had a log', () => {
  const failing = writeStub('exit 1');
  const result = runLogTail(failing, '15');
  assertEq(result.status, 0, 'still exits 0');
  assert(/no media-server log was available/.test(result.stdout), 'and says there was nothing to show');
});

await test('a hostile line count never reaches the shell that runs inside the container', () => {
  // THE LINE COUNT IS INTERPOLATED INTO AN `sh -c` STRING that runs inside the media server's container, so
  // it is validated before it gets there. A diagnostic that executed `40; touch /tmp/pwned` would be a far
  // worse failure than the one it was called to explain.
  const marker = join(mkdtempSync(join(tmpdir(), 'plex-inject-')), 'pwned');
  // The stub echoes the command it was asked to run, so the test can see exactly what would have executed.
  const echoing = writeStub('echo "ARGS: $*"');
  for (const hostile of [`40; touch ${marker}`, '$(touch /tmp/x)', '`id`', '-1', '0', '99999', 'abc', '']) {
    const result = runLogTail(echoing, '15', hostile);
    assertEq(result.status, 0, `it survives ${JSON.stringify(hostile)}`);
    assert(/tail -n 40 /.test(result.stdout),
      `an invalid or out-of-range line count falls back to 40, got: ${result.stdout.trim()}`);
    assert(!result.stdout.includes('touch'), 'and nothing hostile is passed through');
  }
  assert(!existsSync(marker), 'and no injected command ran');
  // A LEGITIMATE value is still honoured, so the validation is not just a constant.
  const ok = runLogTail(echoing, '15', '25');
  assert(/tail -n 25 /.test(ok.stdout), `a valid line count is used as given: ${ok.stdout.trim()}`);
  const capped = runLogTail(echoing, '15', '201');
  assert(/tail -n 40 /.test(capped.stdout), 'and one over the cap of 200 falls back');
});

await test('one enormous log line is truncated, so the diagnostic cannot bury the failure', () => {
  // A LINE BOUND IS NOT A BYTE BOUND. Plex logs base64 plugin payloads that run to tens of kilobytes on a
  // single line; forty of those is a megabyte of stderr on top of a failure somebody has to read.
  const huge = writeStub(String.raw`printf 'A%.0s' $(seq 1 200000); printf '\n'`);
  const result = runLogTail(huge, '15', '40', '4096');
  assertEq(result.status, 0, 'it collects');
  assert(result.stdout.length <= 8_192,
    `the output is bounded, got ${result.stdout.length} bytes`);
  assert(result.stdout.includes('AAAA'), 'while still showing the start of what was there');
});

await test('the gate calls the bounded collector rather than docker exec directly', () => {
  assert(GATE.includes('projection-plex-log-tail.sh'), 'the gate uses the bounded script');
  const dieBody = GATE.split('die() {')[1]?.split('\n}')[0] ?? '';
  assert(!/docker exec/.test(dieBody), 'and die() no longer runs docker exec itself');
  assert(/exit 1/.test(dieBody), 'while still failing the gate');
});

// ---------------------------------------------------------------------------------------------------------
// The redaction check, over the artifact format that is actually written
// ---------------------------------------------------------------------------------------------------------

function runCli(argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', join(repoRoot, 'src/ops/projection-plex-dataplane-cli.ts'),
    ...argv], { encoding: 'utf8', cwd: repoRoot, shell: process.platform === 'win32' });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

await test('redaction-check reads the NDJSON the gate actually writes, not whatever the name suggests', () => {
  // THE DEFECT THIS CLOSES. The check picked `JSON.parse` for anything ending in `.json`. The results
  // artifact IS called `results.json` and IS NDJSON — one GateResult per line, appended by `appendResult` as
  // each phase records a verdict — so the last step of a run that had produced 272 passing assertions died
  // with `Unexpected non-whitespace character after JSON at position 141`. The redaction check is the last
  // thing between a report and whatever it might leak, and it was deciding how to parse its subject by
  // looking at the subject's NAME.
  const dir = mkdtempSync(join(tmpdir(), 'plex-redaction-'));
  const clean = join(dir, 'results.json');
  writeFileSync(clean, `${JSON.stringify({ gate: 'PX3-corpus-matched', verdict: 'pass', measured: 50, budget: 50 })}\n`
    + `${JSON.stringify({ gate: 'PX4-direct-play-digest:abc', verdict: 'pass' })}\n`);
  const ok = runCli(['redaction-check', '--file', clean]);
  assertEq(ok.status, 0, `two NDJSON lines are read and pass: ${ok.stderr}`);
  assert(/redaction-safe/.test(ok.stdout), 'and it says so');
});

await test('redaction-check still CATCHES a leak in that same NDJSON format', () => {
  // A reader that parsed the file but stopped checking it would be worse than the crash: the crash was
  // visible. This proves the fix kept the teeth.
  const dir = mkdtempSync(join(tmpdir(), 'plex-redaction-leak-'));
  const leaky = join(dir, 'results.json');
  writeFileSync(leaky, `${JSON.stringify({ gate: 'PX3-corpus-matched', verdict: 'pass' })}\n`
    + `${JSON.stringify({ gate: 'PX4-play', verdict: 'pass', note: 'fetched http://fakerange:8099/direct/x' })}\n`);
  const bad = runCli(['redaction-check', '--file', leaky]);
  assert(bad.status !== 0, 'a locator on the SECOND line is refused');
  assert(/not redaction-safe/.test(bad.stderr), 'and named as such');
  assert(/a URL/.test(bad.stderr), 'with what was found');
});

await test('an empty results artifact is a failure, not a vacuous pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plex-redaction-empty-'));
  const empty = join(dir, 'results.json');
  writeFileSync(empty, '');
  const result = runCli(['redaction-check', '--file', empty]);
  assert(result.status !== 0, 'nothing to check is not the same as nothing wrong');
  assert(/no subject/.test(result.stderr), 'and it says why');
});

// ---------------------------------------------------------------------------------------------------------
// What a Plex scan costs, and the claim that is NOT being made about it
// ---------------------------------------------------------------------------------------------------------

await test('the scan ceiling is BLOCK GEOMETRY, and is independent of the fixture\'s size', () => {
  // THE MULTIPLIER THIS REPLACES WAS REJECTED, AND RIGHTLY. Three byte budgets failed and the first answer
  // was `MAX_SCAN_BYTE_MULTIPLIER = 3.0` — a number above 1.0 chosen to sit above what had been measured.
  // That is a record of an observation with room around it, not a budget: it would have passed a daemon that
  // read every object three times over, and it retired the product's central claim rather than testing it.
  const chunk = PLEX_READ_GEOMETRY.CHUNK_BYTES;
  const fixed = PLEX_READ_GEOMETRY.OPENS_PER_NEW_ITEM * PLEX_READ_GEOMETRY.DEMAND_BLOCKS_PER_OPEN * chunk;
  assertEq(chunk, 4 * 1024 * 1024, 'the demand block is the daemon\'s readpath.ChunkBytes');
  assertEq(PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES, 1_048_576, 'and the probe window is the manifest\'s');
  // A LARGE OBJECT'S CEILING SATURATES AT THE FIXED WINDOW, WHATEVER ITS SIZE. That is the shape of the
  // model — a ceiling on what a scan may read, not a prediction of what it will.
  assertEq(plexScanByteCeiling([512 * 1024 * 1024]), fixed, 'a 512 MiB object saturates the window');
  assertEq(plexScanByteCeiling([100 * 1024 * 1024]), fixed, 'and so does a 100 MiB one');
  // ...AND A SMALL ONE IS CLAMPED BY ITSELF: forty kilobytes cannot be allowed a four-megabyte block.
  assertEq(plexScanByteCeiling([40_000]), PLEX_READ_GEOMETRY.OPENS_PER_NEW_ITEM * 40_000,
    'a tiny corpus entry is clamped by its own length');
  assertEq(plexScanByteCeiling([40_000, 40_000]), plexScanByteCeiling([40_000]) * 2, 'and they sum');
  assertEq(plexScanByteCeiling([]), 0, 'nothing costs nothing');
});

await test('the block-geometry ceiling admits every measured scan and refuses a runaway', () => {
  // Held against the three real measurements from a full run, and against the failure it must still catch.
  const anchor = 13_981_407;
  const soak = 8_594_275;
  const corpus = Array.from({ length: 38 }, () => Math.round(1_535_672 / 38));
  assert(plexScanByteCeiling([anchor]) >= 17_825_792,
    'the measured two-entry scan of 17,825,792 bytes is inside the ceiling');
  assert(plexScanByteCeiling([anchor, soak, ...corpus]) >= 40_096_953,
    'and so is the measured corpus scan of 40,096,953');
  // THE TEETH: a read path that served every object ten times over is still refused.
  assert(plexScanByteCeiling([anchor, soak, ...corpus]) < 10 * (anchor + soak + 1_535_672),
    'while a ten-times-over read path is not');
});

await test('the product\'s fraction claim is asserted, on an object big enough for it to mean something', () => {
  // On a fixture smaller than the 24 MiB the ceiling saturates at, the ceiling already permits a
  // whole-object read — so satisfying it proves nothing about the fraction. That is a limit of the
  // INSTRUMENT, not a lower bound: it does not mean a below-one read is unreachable at those sizes. The
  // claim therefore moves to a fixture where an ACTUAL-BYTE measurement has margin, held to the SHARED
  // constant the Jellyfin gate is held to rather than one of Plex's own.
  const saturated = PLEX_READ_GEOMETRY.OPENS_PER_NEW_ITEM * PLEX_READ_GEOMETRY.DEMAND_BLOCKS_PER_OPEN
    * PLEX_READ_GEOMETRY.CHUNK_BYTES;
  assertEq(PLEX_LARGE_FIXTURE.MAX_SCAN_BYTE_FRACTION, MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION,
    'the same fraction, not a Plex-specific one');
  assertEq(MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION, 0.5, 'and the shared constant is untouched');
  assert(PLEX_LARGE_FIXTURE.MIN_BYTES >= saturated / PLEX_LARGE_FIXTURE.MAX_SCAN_BYTE_FRACTION,
    'and the fixture is large enough that the saturated ceiling sits under the fraction with margin');
  assert(GATE.includes('--large-bytes "$LARGE_SIZE"'), 'the gate asserts the fraction on it');
  assert(/test "\$LARGE_SIZE" -ge 100663296/.test(GATE),
    'and refuses to run the claim against a fixture that came out too small to test it');
});

await test('the re-scan budget is untouched, and it is the strongest claim Plex does support', () => {
  // A second scan of an unchanged generation must cost the provider ZERO ranged GETs and ZERO bytes. That is
  // the daemon's scan-window cache doing exactly what it exists for; it holds on Plex, and nothing above
  // relaxes it.
  assert(GATE.includes('--gate PX14-rescan --entries 1 --bytes 0 --windows 0'),
    'the re-scan is budgeted at zero bytes and zero windows');
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  assert(/if \(sizes\.length > 0\)/.test(cli),
    'and the geometry ceiling is skipped when no object sizes are named, so it cannot turn a zero-cost '
    + 're-scan into a failure');
});

await test('the scan AFTER A MEDIA-SERVER RESTART is budgeted, not just its churn', () => {
  // THE GAP THIS CLOSES. The gate measured churn across the restart and measured the WARM repeat scan at
  // zero provider bytes, and drew a counter window around neither the restart scan itself. Measured: the
  // restart re-fetched +37,924,876 bytes over +14 ranges, and the scan immediately after cost zero. Letting
  // only the warm scan carry the zero-refetch claim was the strongest-sounding half of a two-part
  // measurement with the expensive half unmeasured.
  assert(GATE.includes('counters-before-restart-scan.json'), 'a window opens before the restart scan');
  assert(GATE.includes('counters-after-restart-scan.json'), 'and closes after it');
  assert(GATE.includes('--gate PX12b-restart-scan'), 'and it carries a budget');
  const restart = GATE.split('restarting the media server')[1]?.split('step "')[0] ?? '';
  assert(restart.indexOf('counters-before-restart-scan') < restart.indexOf('--label scan4'),
    'the window really does bracket scan4');
});

await test('the corpus-scan denominator names EVERY remote object, one size at a time', () => {
  // THE DEFECT THIS CLOSES. It named the soak source and the corpus and silently omitted the remote anchor,
  // which is in this library and is re-scanned by this very scan. And the sizes cannot be summed before they
  // reach the budget: the ceiling clamps each object by its own length, so folding them together would let
  // the large entries buy headroom for the small ones.
  assert(/CORPUS_SIZE_LIST="\$\(node "\$REL\/sizelist\.cjs"/.test(GATE), 'the sizes are listed individually');
  assert(GATE.includes('--object-sizes "$CORPUS_SIZE_LIST"'), 'and handed to the budget as a list');
  assert(/CORPUS_SIZE_LIST="\$\{CORPUS_SIZE_LIST\},\$\{LARGE_SIZE\}"/.test(GATE),
    'and the list grows with the library, so a later scan is not budgeted against a smaller one');
});

await test('the provider is NEVER restarted mid-run, so lifetime evidence survives', () => {
  // THE DEFECT THIS CLOSES. Adding the large object by restarting the fake endpoint would have reset its
  // process-lifetime counters — and PX15 asserts over the WHOLE run that it served zero 429s, zero full-body
  // answers to a ranged request and never exceeded the connection cap. Every violation before the restart
  // would have been discarded while PX15 went on claiming to describe the run.
  const launches = GATE.split('go run ./cmd/fakerange').length - 1;
  assertEq(launches, 1, 'the endpoint is launched exactly once');
  assert(GATE.includes(`--file-object "\${LARGE_REF}=/remote/\${LARGE_FILE}"`),
    'and the large object is registered with it at that single launch');
  // The file must therefore exist before the launch: generated in the media step, published much later.
  const beforeLaunch = GATE.split('go run ./cmd/fakerange')[0] ?? '';
  assert(beforeLaunch.includes('LARGE_SIZE="$(wc -c < "$WORK/remote/$LARGE_FILE"'),
    'the large fixture is generated and sized before the endpoint starts');
  assert(!/docker rm -f "\$RANGE_CONTAINER" >\/dev\/null 2>&1 \|\| true\n +docker run -d --name "\$RANGE_CONTAINER"/
    .test(GATE), 'and nothing tears the endpoint down and brings it back');
});

await test('every post-large baseline carries the large item, and the denominators agree', () => {
  // Once PX9c publishes it, the large object stays in the library. A later scan measured against an
  // expectation that omits it would fail on item count; a later BUDGET measured against a denominator that
  // omits it would be wrong in the quiet direction.
  assert(GATE.includes('"$REL/out/expected-2.json" "$REL/out/expected-large.json"'),
    'the successor expectation derives from the large one');
  assert(GATE.includes('--before "$REL/out/items-large.json" --after "$REL/out/items-2.json"'),
    'and the successor comparison uses the post-large listing as its baseline');
  assert(/CORPUS_SIZE_LIST="\$\{CORPUS_SIZE_LIST\},\$\{LARGE_SIZE\}"/.test(GATE),
    'the size list grows to include it');
  // ...and the entry count grows with it: anchor + soak + large, on top of the corpus.
  assert(GATE.includes('--gate PX12b-restart-scan --entries "$(( CORPUS_REMOTE_ENTRIES + 3 ))"'),
    'the restart scan counts three large remote entries beside the corpus');
  assert(GATE.includes('--gate PX9b-corpus-scan --entries "$(( CORPUS_REMOTE_ENTRIES + 2 ))"'),
    'while the corpus scan, which runs BEFORE the large object exists, still counts two');
  // Every expectation after PX9c chains from expected-large, so LARGE_FILE is in all of them.
  for (const chain of ['"$REL/out/expected-midscan.json" "$REL/out/expected-2.json"',
    '"$REL/out/expected-3.json" "$REL/out/expected-midscan.json"']) {
    assert(GATE.includes(chain), `the expectation chain is unbroken at ${chain}`);
  }
});

await test('the byte floor is per object, and cannot be cross-subsidised or defaulted away', () => {
  // THE DEFECT THIS CLOSES. The floor was `min(totalRemote, count x 1 MiB)` and `totalRemote` came from
  // `--bytes`, which defaults to 1 — so the restart-scan call, which names sizes but no `--bytes`, had a
  // floor of ONE BYTE and could not fail. And even when `--bytes` was given, the terms were pooled: thirty-
  // eight tiny objects that were never opened could be paid for by one large one that was.
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  assert(/sizes\.reduce\(\s*\(total, size\) => total \+ Math\.min\(size, PLEX_READ_GEOMETRY\.PROBE_WINDOW_BYTES\)/
    .test(cli), 'the floor sums one probe window per object, clamped by the object');
  assert(!/Math\.min\(totalRemote, sizes\.length/.test(cli), 'and never pools them');
  assert(!/const totalRemote/.test(cli), 'the pooled total is gone entirely');
  // The arithmetic, on a mixed library: 38 tiny objects plus two large ones.
  const window = PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES;
  const tiny = Array.from({ length: 38 }, () => 40_000);
  const mixedFloor = [...tiny, 8_594_275, 13_981_407]
    .reduce((total, size) => total + Math.min(size, window), 0);
  assertEq(mixedFloor, 38 * 40_000 + 2 * window,
    'each tiny object contributes its own length and each large one contributes one window');
  assert(mixedFloor > 2 * window,
    'so a run that opened only the two large objects cannot clear the floor for the other thirty-eight');
  // And the restart-scan call names sizes, which is what makes the floor apply to it at all.
  assert(GATE.includes('--gate PX12b-restart-scan') && GATE.includes('--object-sizes "$CORPUS_SIZE_LIST"'),
    'the restart-scan call names object sizes, so it gets a real floor');
});

await test('the seek ceiling is per-seek block geometry, not a multiple of the fixture', () => {
  const perSeek = PLEX_READ_GEOMETRY.DEMAND_BLOCKS_PER_OPEN * PLEX_READ_GEOMETRY.CHUNK_BYTES;
  assertEq(plexSeekByteCeiling(10) - plexSeekByteCeiling(9), perSeek,
    'each additional seek adds exactly one encoder restart\'s worth of demand blocks');
  assert(plexSeekByteCeiling(0) > 0, 'and there is a fixed session-setup allowance beneath it');
  assert(plexSeekByteCeiling(10) >= 54_485_469, 'the measured ten-seek cost is inside the ceiling');
  // IT DOES NOT DEPEND ON THE OBJECT AT ALL, which is what made `1.2 x object x 10` unstable: a hair above
  // the arithmetic floor on a small fixture and meaningless on a large one.
  assert(GATE.includes('--events 10 --seek-ceiling true'), 'the gate asks for the derived ceiling');
  assert(!GATE.includes('--max-object-multiplier 1.2'), 'and no longer for an object multiple');
});

// ---------------------------------------------------------------------------------------------------------
// The gate script itself
// ---------------------------------------------------------------------------------------------------------


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

await test('every container is handed the media server\'s ADDRESS, never its container name', () => {
  // MEASURED, AND IT COST A RUN. Plex refuses a request whose Host header is a name it does not recognise:
  // its own log says `Request came in with unrecognized domain / IP '<name>' in header Host; treating as
  // non-local`, and it answers 401. Same peer, same network, same unclaimed server: by-name 401, by-ip 200,
  // by-ip-with-a-name-in-Host 401, by-name-with-an-ip-in-Host 200. `allowedNetworks` does not override it.
  assert(PLEX_REJECTS_UNRECOGNISED_HOST_HEADER, 'the contract records the behaviour');
  assert(/PLEX_IP="\$\(docker inspect "\$PLEX_CONTAINER"/.test(GATE),
    'the gate resolves the server\'s address');
  assert(/test -n "\$PLEX_IP"/.test(GATE), 'and refuses to continue without one');
  assert(GATE.includes('--stream-base "http://${PLEX_IP}:32400"'),
    'and the paced consumer is given that address');
  assert(!/--stream-base "http:\/\/\$\{?PLEX_CONTAINER/.test(GATE),
    'never the container name, which is what produced the 401');
  assert(/unrecognized domain \/ IP/.test(GATE), 'and the gate records the server\'s own explanation');
});

await test('the plex.tv skip check is GONE, because the finding behind it was wrong', () => {
  // The gate used to skip with 77 when servers.plex.tv did not resolve, on the strength of a measurement
  // that turned out to be confounded by the Host header above. Re-measured on a --internal network with the
  // server addressed by IP, an air-gapped unclaimed Plex answers /, /library/sections and /:/prefs with 200
  // and creates a library. A false SKIP is the same family of defect as a false PASS.
  assertEq(PLEX_UNCLAIMED_LOCAL_API_REQUIRES_PLEX_TV_REACHABILITY, false,
    'the contract records the corrected finding');
  assert(!/nslookup servers\.plex\.tv/.test(GATE), 'the check is deleted, not softened');
  assert(/There is no plex\.tv reachability check here|THERE IS NO plex\.tv REACHABILITY CHECK HERE/.test(GATE),
    'and the gate says why, so nobody re-adds it');
  const doc = read('docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md');
  assert(/air-gapped/i.test(doc), 'the document states what was actually measured');
});

await test('the air-gapped claim is exactly as wide as the requests that were made', () => {
  // The corrected finding must not drift upward into "the whole local API" or "entirely usable". Four
  // requests were made; scanning, playback, seeking and transcoding air-gapped are not established, because
  // this gate has never run that way.
  assertEq(PLEX_AIR_GAPPED_TESTED_PATHS.length, 4, 'four endpoints, enumerated');
  for (const path of ['GET /', 'GET /library/sections', 'GET /:/prefs', 'POST /library/sections']) {
    assert(PLEX_AIR_GAPPED_TESTED_PATHS.includes(path), `${path} is one of them`);
  }
  const doc = read('docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md');
  assert(!/entirely usable/.test(doc), 'the doc does not say "entirely usable"');
  assert(!/answers its whole local API/.test(doc), 'nor "answers its whole local API"');
  assert(/not.{0,40}established/is.test(doc), 'and says what is not established');
  // AND NO OPERATIONAL TEXT STILL BLAMES plex.tv. These are diagnostics an operator reads, not just prose.
  const driver = read('src/ops/projection-plex-dataplane.ts');
  assert(!/contingent on the server (being able to reach|having reached) plex\.tv/.test(driver),
    'the driver no longer attributes a 401 to plex.tv');
  assert(!/an unclaimed Plex needs in order to answer/.test(read('deploy/projection-plex-dataplane-gate-optional.sh')),
    'and neither does the optional wrapper');
  assert(!/media server container has internet egress and an unclaimed Plex requires it/.test(GATE),
    'and neither does the gate\'s closing summary');
  assert(!/nslookup servers\.plex\.tv/.test(GATE), 'and the skip check is gone');
});

await test('the media server\'s address is resolved on the NAMED gate network', () => {
  // A `range` over .NetworkSettings.Networks concatenates every address the container has, so the moment it
  // is attached to a second network the consumer is handed a URL that resolves to nothing.
  assert(/{{index \.NetworkSettings\.Networks \\"\$NETWORK\\" \\"IPAddress\\"}}/.test(GATE),
    'the address is indexed by the gate network\'s name');
  assert(!/{{range \.NetworkSettings\.Networks}}{{\.IPAddress}}{{end}}/.test(GATE),
    'never ranged over every network');
  assert(/\*\[!0-9\.\]\*/.test(GATE), 'and what comes back is checked to be a bare IPv4 address');
});

await test('the session warm-up is timed apart from the ten seeks, and is itself bounded', () => {
  // A seek is a transition within an ESTABLISHED session. The first segment of a cold session waits for the
  // encoder to launch, open the projected file through the mount and start writing — that is playback
  // startup, which G8 budgets and G9 does not mention. Charging it to seek number one measured two things
  // under one name. The ten-second contract for all ten seeks is unchanged.
  const driver = read('src/ops/projection-plex-dataplane.ts');
  assert(/readonly warmupMs: number/.test(driver), 'the warm-up is a returned measurement');
  assert(/const warmupStart = now\(\)/.test(driver), 'timed around the first fetch');
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  assert(/PX19-session-warmup-seconds/.test(cli), 'and asserted under its own gate id');
  assert(/MEDIA_SERVER_DEADLINES_MS\.SEEK \/ 1_000/.test(cli),
    'against a real ceiling, so a session that took a minute fails rather than vanishing between two gates');
  assertEq(MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS, 10, 'and the ten-second seek contract is untouched');
  assert(/PX19-seek-elapsed-profile/.test(cli),
    'with a per-seek breakdown recorded, so a failing slowest-seek number is diagnosable at all');
});

await test('the warm-up reads a position the seek plan never asks for', () => {
  // Otherwise it would pre-warm one of the ten and the gate would be measuring a seek it had already paid
  // for. The plan's smallest fraction is 0.02 of the duration, and the warm-up reads segment 0.
  const driver = read('src/ops/projection-plex-dataplane.ts');
  assert(/await fetchSegment\(state, session, 0,/.test(driver), 'the warm-up reads segment zero');
  const smallest = Math.min(...SEEK_PLAN_FRACTIONS);
  assert(smallest > 0, 'and no planned position is the very start of the media');
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

await test('the Plex document keeps the RETRACTED plex.tv finding, and the confound that produced it', () => {
  // A confounded experiment that produced a confident wrong conclusion is worth more as a record than as an
  // absence. This asserts the document did not quietly tidy it away and replace it with the right answer as
  // though the right answer had always been there — which is the shape of edit this repository exists to
  // stop making.
  assertEq(PLEX_UNCLAIMED_LOCAL_API_REQUIRES_PLEX_TV_REACHABILITY, false,
    'the contract carries the corrected finding');
  const doc = read('docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md');
  assert(/plex\.tv/.test(doc), 'the document names plex.tv');
  assert(/401/.test(doc), 'and the refusal that was observed');
  assert(/internal/.test(doc), 'and how it was measured');
  assert(/false|wrong|retract/i.test(doc), 'and says the conclusion drawn from it was not right');
  assert(/Host/.test(doc), 'and names the Host header as what was actually refusing');
  assert(/air-gapped/i.test(doc), 'and states what the corrected measurement showed');
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
