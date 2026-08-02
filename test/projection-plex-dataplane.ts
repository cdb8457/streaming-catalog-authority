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
  PLEX_REJECTS_UNRECOGNISED_HOST_HEADER, PLEX_SCAN_ENVELOPE, PLEX_SEEK_IS_AN_OFFSET_RESTART,
  PLEX_SEGMENT_CONTAINER, PLEX_SERVER_PREFS, PLEX_GATE6_COMPATIBLE_BLOCKS,
  PLEX_INSTRUMENTED_SCAN_WINDOWS, plexHighestCorpusScanRatio, plexHighestMeasuredPerEntry,
  plexInstrumentedWindowCounts, plexObjectByteCeiling,
  plexLargeFixtureMinBytes, plexScanByteCeiling, plexScanRequestCeilings, plexSeekByteCeiling,
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

// EVERY FILE THAT DESCRIBES THE SCAN BUDGET, listed once so a regression ban cannot be satisfied by moving a
// stale claim into a file the ban did not name. The scan model has now been restated four times, and each
// sweep left a copy somewhere the previous test was not looking.
// A BAN THAT SCANS THIS SUITE TOO HAS TO SKIP THE LINES THAT DECLARE IT, or every ban trips on its own
// regex. Only the assertion lines are dropped — comments are kept, because a stale claim parked in a test
// comment is exactly how one of these survived two sweeps.
const withoutBanDeclarations = (text: string): string => text.split('\n')
  .filter((line) => !line.includes('assert(!/') && !line.includes('.test(text)')
    && !line.includes('${source} does not')
    // The retired-formula scan declares its patterns and its human labels as data; both necessarily quote
    // the phrases being banned, and a ban that trips on its own table is a ban nobody keeps.
    && !line.includes('pattern: /') && !line.includes('what: \''))
  .join('\n');

const SCAN_MODEL_SOURCES = Object.freeze([
  'src/core/projection/plex-dataplane.ts',
  'src/ops/projection-plex-dataplane-cli.ts',
  'deploy/projection-plex-dataplane-gate.sh',
  'docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md',
  'docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md',
]);

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
// The opt-in geometry diagnostic, which is not a gate and must not be able to look like one
// ---------------------------------------------------------------------------------------------------------

/**
 * The gate script with every diagnostic-guarded region removed — i.e. exactly the default path.
 *
 * IT COUNTS NESTED `if`s, and the first version did not. The diagnostic block contains readiness loops with
 * their own `if … then … fi` inside, so a stripper that closed on the first bare `fi` stopped early and left
 * the tail of the block — including its `exit` — looking like part of the default path. The test then failed
 * for a reason that had nothing to do with the gate, which is its own kind of false signal.
 */
function gateWithoutDiagnostic(): string {
  const lines = GATE.split('\n');
  const kept: string[] = [];
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (depth === 0 && /^if \[ "\$GEOMETRY_DIAGNOSTIC" = "1" \]; then$/.test(trimmed)) {
      depth = 1;
      continue;
    }
    if (depth > 0) {
      // Any `if … then` opens a nested block; `fi` closes the innermost one. Only when the outermost closes
      // are we back on the default path.
      if (/^if .*; then$/.test(trimmed) || /^if .*$/.test(trimmed) === false && trimmed === 'then') depth += 1;
      else if (trimmed === 'fi') depth -= 1;
      continue;
    }
    kept.push(line);
  }
  if (depth !== 0) throw new Error(`unbalanced diagnostic guard: depth ${depth} at end of script`);
  return kept.join('\n');
}

await test('the geometry diagnostic is OFF unless it is asked for by name', () => {
  assert(GATE.includes('GEOMETRY_DIAGNOSTIC="${PROJECTION_PLEX_GEOMETRY_DIAGNOSTIC:-0}"'),
    'it defaults to off');
  // EVERY diagnostic-only region is guarded by the same explicit test — no partial guards, no `-n` checks
  // that a stray empty string would satisfy.
  const guards = GATE.split('\n').filter((line) => line.includes('GEOMETRY_DIAGNOSTIC'));
  for (const guard of guards) {
    assert(/GEOMETRY_DIAGNOSTIC="\$\{PROJECTION_PLEX_GEOMETRY_DIAGNOSTIC:-0\}"/.test(guard)
      || /\[ "\$GEOMETRY_DIAGNOSTIC" = "1" \]/.test(guard)
      || guard.trimStart().startsWith('#')
      || guard.trimStart().startsWith('echo '),
    `every mention is the definition, an exact "=1" guard, a comment or printed text: ${guard.trim()}`);
  }
});

await test('the DEFAULT path reaches every scoring phase and never early-exits', () => {
  // The production gate must be unchanged in phase order. This checks the default path specifically — with
  // the diagnostic regions stripped — so a guard that failed to close would show up as a missing phase.
  const plain = gateWithoutDiagnostic();
  for (const phase of ['ten real media-time seeks', 'direct play, PACED, for five minutes',
    'a forced transcode, run and consumed for five minutes', 'a successor published while a stream is in flight',
    'SIGKILL the daemon during playback', 'restarting the media server',
    'a generation admitted WHILE A SCAN IS RUNNING', 'a source outage is not a deletion',
    'the media server cannot write to the projection', 'no PROVIDER access lease reached', 'the report']) {
    assert(plain.includes(phase), `the default path still runs: ${phase}`);
  }
  // ...and the default path can leave early only by SKIPPING or by FAILING. `die` exits 1, which is a
  // failure and is meant to stop the run; the FUSE check exits 77. Anything else would be a path that ends
  // the gate without either passing every phase or saying it did not.
  const exits = plain.split('\n').filter((line) => /^\s*exit /.test(line));
  assert(exits.length > 0, 'the default path does have deliberate exits');
  for (const line of exits) {
    assert(/GATE_SKIP_STATUS/.test(line) || /^\s*exit 1$/.test(line),
      `the default path exits only to skip or to fail: ${line.trim()}`);
  }
  assert(!plain.includes('GEOMETRY_EXIT_STATUS"'), 'and never with the diagnostic status');
  // THE SECOND FIXTURE IS NEVER ACTED ON WHEN THE MODE IS OFF. The check is on ACTIONS rather than on the
  // identifiers: the variable names are defined unconditionally so the guarded blocks stay small, and an
  // inert assignment costs nothing. What must not happen on the default path is an encode, a registration,
  // a publish, a scan or a shape record.
  for (const [marker, what] of [
    ['duration=45', 'encoding the second fixture'],
    ['--key second-large', 'registering it'],
    ['publish-second-large.json', 'publishing it'],
    ['--label second-large', 'scanning it'],
    ['drive shape-window', 'recording a shape window'],
    ['PXD-', 'emitting a diagnostic record'],
    ['DIAGNOSTIC_OBJECT_FLAGS+=', 'adding it to the provider launch'],
  ] as Array<[string, string]>) {
    assert(!plain.includes(marker), `the default path does not do ${what}`);
  }
});

await test('the diagnostic exits 78, which is neither a pass nor a skip', () => {
  assert(GATE.includes('GEOMETRY_EXIT_STATUS=78'), 'the status is 78');
  assert(GATE.includes('exit "$GEOMETRY_EXIT_STATUS"'), 'and the diagnostic exits with it');
  assert(GATE.includes('GATE_SKIP_STATUS=77'), 'while a skip is still 77');
  // THE THREE-RUN WRAPPER COUNTS ONLY ZERO, so 78 can never become one of the three required runs, and the
  // OPTIONAL entry point maps only 77, so it cannot be laundered into a success either.
  const three = read('deploy/projection-plex-dataplane-gate-three.sh');
  assert(!three.includes('78'), 'the three-run wrapper knows nothing about 78');
  assert(/if \[ "\$status" -ne 0 \]; then/.test(three), 'and treats any non-zero as a failed run');
  const optional = read('deploy/projection-plex-dataplane-gate-optional.sh');
  assert(/if \[ "\$status" -eq "\$GATE_SKIP_STATUS" \]/.test(optional), 'the optional wrapper maps only 77');
  assert(!optional.includes('78'), 'and never 78');
});

await test('a diagnostic run announces loudly that it proved nothing', () => {
  const banner = GATE.split('DIAGNOSTIC ONLY')[1]?.split('exit "$GEOMETRY_EXIT_STATUS"')[0] ?? '';
  assert(banner.length > 0, 'there is a banner');
  assert(/NO GATE PASSED/.test(GATE), 'it says no gate passed');
  assert(/NOTHING HERE IS EVIDENCE FOR ANY ACCEPTANCE GATE/.test(GATE), 'and that it is not evidence');
  // It enumerates what it did NOT do, so a reader cannot mistake a short run for a complete one.
  for (const skipped of ['ten seeks', 'five-minute paced play', 'five-minute transcode', 'SIGKILL',
    'mid-scan publish', 'source outage', 'lease-secrecy']) {
    assert(banner.includes(skipped), `the banner names ${skipped} among what it did not run`);
  }
  assert(/no acceptance record, run record/.test(banner), 'and that no record is updated');
});

await test('the diagnostic scores nothing: shape and partitions only', () => {
  const diagnostic = GATE.split('GEOMETRY DIAGNOSTIC: a second large object')[1]
    ?.split('exit "$GEOMETRY_EXIT_STATUS"')[0] ?? '';
  assert(diagnostic.includes('drive shape-window'), 'it records the shape');
  assert(!diagnostic.includes('drive budget'), 'and applies no budget');
  assert(!diagnostic.includes('--large-bytes'), 'and no byte fraction');
  assert(!diagnostic.includes('--object-sizes'), 'and no geometry ceiling');
  // `shape-window` itself must assert the partitions and nothing else.
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  const shapeWindow = cli.split("case 'shape-window':")[1]?.split("case 'assert-scan-in-flight'")[0] ?? '';
  assert(shapeWindow.includes('-request-shape-accounts-for-every-byte'), 'byte partition asserted');
  assert(shapeWindow.includes('-request-shape-accounts-for-every-request'), 'request partition asserted');
  assert(!/withinBudget|atLeast/.test(shapeWindow), 'and no ceiling or floor is applied anywhere in it');
});

await test('the diagnostic isolates both windows and keeps the provider launched once', () => {
  const diagnostic = GATE.split('GEOMETRY DIAGNOSTIC: a second large object')[1]
    ?.split('exit "$GEOMETRY_EXIT_STATUS"')[0] ?? '';
  // Its own generation, its own before/after pair, and the first object's window re-stated beside it.
  assert(diagnostic.includes('counters-before-second.json') && diagnostic.includes('counters-after-second.json'),
    'the second object has its own counter window');
  assert(diagnostic.includes('--gate PXD-second-large-object'), 'reported under its own name');
  assert(diagnostic.includes('--gate PXD-first-large-object'),
    'and the first object is re-stated so the two are read together');
  assert(/additions < "\$WORK\/out\/publish-second-large\.json"\)" = "1"/.test(diagnostic),
    'the second object is published alone, adding exactly one entry');
  // STILL EXACTLY ONE PROVIDER LAUNCH. Adding an object by restarting the endpoint would reset the lifetime
  // counters, which is the defect this gate already fixed once.
  assertEq(GATE.split('go run ./cmd/fakerange').length - 1, 1, 'the endpoint is launched exactly once');
  assert(GATE.includes('"${DIAGNOSTIC_OBJECT_FLAGS[@]}"'),
    'and the second object joins that single launch');
  assert(gateWithoutDiagnostic().includes('DIAGNOSTIC_OBJECT_FLAGS=()'),
    'with an empty array on the default path, so the launch is unchanged there');
});

await test('the two diagnostic fixtures differ enough to answer the question, and it is asserted', () => {
  // One object cannot distinguish a fixed per-item cost from one that scales with size. The gate refuses to
  // produce evidence that could not answer its own question.
  assert(/test "\$SECOND_LARGE_SIZE" -lt "\$\(\( LARGE_SIZE \/ 2 \)\)"/.test(GATE),
    'the second object must be under half the first');
  assert(/too close to tell a fixed cost from a scaling one/.test(GATE), 'and the failure says why');
  // SAME CODEC AND SETTINGS, so size is the only variable.
  const first = GATE.split(`-f lavfi -i "testsrc2=size=640x480:rate=24:duration=105"`)[1]?.split('"/work/remote/')[0] ?? '';
  const second = GATE.split(`-f lavfi -i "testsrc2=size=640x480:rate=24:duration=45"`)[1]?.split('"/work/remote/')[0] ?? '';
  assert(first.length > 0 && second.length > 0, 'both encodes exist');
  const settings = (block: string): string => (block.match(/-c:v [^\n]*|-b:v [^\n]*|-c:a [^\n]*/g) ?? []).join(' ');
  assertEq(settings(second), settings(first),
    'the second fixture uses identical codec settings, so only its size differs');
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

// ---------------------------------------------------------------------------------------------------------
// EXECUTION-LEVEL COVERAGE OF THE BUDGET PHASE. Everything above reads the source; these RUN it, because the
// defect they close was invisible to source reading: the code contained a correct byte assertion, and the
// gate's own call site simply never reached it.
// ---------------------------------------------------------------------------------------------------------

/** Runs `budget` with a real counter pair and returns the recorded NDJSON verdicts. */
function runBudget(argv: readonly string[], before: Record<string, unknown>, after: Record<string, unknown>):
{ status: number; stderr: string; results: Array<{ gate: string; verdict: string; measured?: number; budget?: number }> } {
  const dir = mkdtempSync(join(tmpdir(), 'plex-budget-'));
  const beforePath = join(dir, 'before.json');
  const afterPath = join(dir, 'after.json');
  const resultsPath = join(dir, 'results.json');
  writeFileSync(beforePath, JSON.stringify(before));
  writeFileSync(afterPath, JSON.stringify(after));
  const run = runCli(['budget', '--before', beforePath, '--after', afterPath,
    '--results', resultsPath, ...argv]);
  const results = existsSync(resultsPath)
    ? readFileSync(resultsPath, 'utf8').split('\n').filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { gate: string; verdict: string; measured?: number; budget?: number })
    : [];
  return { status: run.status, stderr: run.stderr, results };
}

const QUIET_COUNTERS = Object.freeze({
  bytesServed: 1_000_000, rangeRequests: 40, resolutions: 5,
  chunkResponses: 8, smallResponses: 12, partialResponses: 3, oversizedResponses: 0,
  chunkBytes: 0, smallBytes: 0, partialBytes: 0, oversizedBytes: 0, bodylessResponses: 0,
  // The partition side. 8 + 12 + 3 + 0 + 0 = 23, so the baseline is internally consistent and a fixture
  // that moves a class without moving this one fails the partition rather than the assertion under test.
  accountedResponses: 23,
});

await test('PX14\'s EXACT argument shape asserts zero bytes - the assertion that was never running', () => {
  // THE BLOCKER THIS CLOSES, AND IT IS THE WORST KIND OF DEFECT THIS REPOSITORY EXISTS TO CATCH. The byte
  // assertion lived inside `if (sizes.length > 0)`. PX14 - the warm re-scan, the strongest amplification
  // claim the gate makes - passes `--entries 1 --windows 0` and NO `--object-sizes`, because it asserts the
  // provider was not touched and has no reason to name a size. So the block was skipped and NO byte
  // assertion ran at all, while the code comment, both documents and an offline test said `--windows 0`
  // forced bytes to zero. A check that cannot fail, described as the strongest claim in the gate.
  //
  // These use the EXACT flags of the gate's own PX14 call site, so the two cannot drift apart.
  const px14 = ['--gate', 'PX14-rescan', '--entries', '1', '--windows', '0'];
  assert(GATE.includes('--gate PX14-rescan --entries 1 --windows 0'),
    'the gate really does call it with these flags and no --object-sizes');

  // A TRULY WARM WINDOW PASSES: nothing moved.
  const warm = runBudget(px14, QUIET_COUNTERS, { ...QUIET_COUNTERS });
  assertEq(warm.status, 0, `an untouched window is accepted: ${warm.stderr}`);
  const warmBytes = warm.results.find((result) => result.gate === 'PX14-rescan-provider-bytes');
  assert(warmBytes !== undefined,
    'and the byte assertion RAN - its absence is the entire defect, so its presence is asserted first');
  assertEq(warmBytes?.verdict, 'pass', 'with a passing verdict');

  // AND ONE THAT TOUCHED THE PROVIDER FAILS. A single 4 KiB read is enough.
  const touched = runBudget(px14, QUIET_COUNTERS,
    { ...QUIET_COUNTERS, bytesServed: QUIET_COUNTERS.bytesServed + 4096 });
  const failed = touched.results.find((result) => result.gate === 'PX14-rescan-provider-bytes');
  assertEq(failed?.verdict, 'fail', 'a warm re-scan that served 4 KiB is a failure, not a silent pass');
  assertEq(failed?.measured, 4096, 'and the report carries what it actually measured');

  // A LARGE READ FAILS TOO, and so does a NEGATIVE delta - counters reset underneath the window is not
  // "within budget", which is why this is an equality and not a ceiling of zero.
  const wholeObject = runBudget(px14, QUIET_COUNTERS,
    { ...QUIET_COUNTERS, bytesServed: QUIET_COUNTERS.bytesServed + 105_406_871 });
  assertEq(wholeObject.results.find((r) => r.gate === 'PX14-rescan-provider-bytes')?.verdict, 'fail',
    'a re-scan that re-downloaded the object fails');
  const reset = runBudget(px14, QUIET_COUNTERS, { ...QUIET_COUNTERS, bytesServed: 0 });
  assertEq(reset.results.find((r) => r.gate === 'PX14-rescan-provider-bytes')?.verdict, 'fail',
    'and a negative delta fails rather than passing as "under budget"');

  // The no-floor record is emitted in the size-free form too, so the report is complete rather than silent.
  assert(warm.results.some((r) => r.gate === 'PX14-rescan-provider-bytes-floor-not-applicable'),
    'and the window records WHY it carries no floor, instead of omitting the subject');
});

await test('EXECUTION: a clipped block spends the block cap, and an oversized body is refused outright', () => {
  // THE REGRESSION FOR gate7's ONLY FAILURE, DRIVEN THROUGH THE REAL PHASE. Its corpus window measured
  // 0 full blocks and 13 clipped ones against a budget asserting the middle class could not exist. These
  // cases replay that shape and the two shapes either side of it.
  const base = ['--gate', 'PXcls', '--entries', '1', '--object-sizes', '100000000'];
  const before = { ...QUIET_COUNTERS };
  const baseline = QUIET_COUNTERS as Record<string, number>;
  const after = (over: Record<string, number>): Record<string, number> =>
    ({ ...QUIET_COUNTERS, ...Object.fromEntries(
      Object.entries(over).map(([k, v]) => [k, (baseline[k] ?? 0) + v])) });

  // gate7's ACTUAL SHAPE, scaled to one entry: clipped blocks, no full ones. It must pass now.
  const clipped = runBudget(base, before, after({
    partialResponses: 5, partialBytes: 5 * 2_724_273, rangeRequests: 5, bytesServed: 5 * 2_724_273,
  }));
  assertEq(clipped.status, 0, `clipped blocks are legitimate: ${clipped.stderr}`);
  assertEq(clipped.results.find((r) => r.gate === 'PXcls-block-responses')?.verdict, 'pass',
    'five clipped blocks are inside the block cap of eight');
  assertEq(clipped.results.find((r) => r.gate === 'PXcls-oversized-responses')?.verdict, 'pass',
    'and none of them is oversized');

  // FULL AND CLIPPED SHARE ONE ALLOWANCE. Four of each is eight, which fits; one more of either does not.
  const atTheCap = runBudget(base, before, after({
    chunkResponses: 4, chunkBytes: 4 * 4 * 1024 * 1024, partialResponses: 4, partialBytes: 4 * 2_000_000,
    rangeRequests: 8, bytesServed: 4 * 4 * 1024 * 1024 + 4 * 2_000_000,
  }));
  assertEq(atTheCap.results.find((r) => r.gate === 'PXcls-block-responses')?.verdict, 'pass',
    '4 full + 4 clipped = 8 is exactly the cap');
  assertEq(atTheCap.results.find((r) => r.gate === 'PXcls-block-responses')?.measured, 8,
    'and the measurement is their SUM, which is what stops the two being additive allowances');
  const overTheCap = runBudget(base, before, after({
    chunkResponses: 5, chunkBytes: 5 * 4 * 1024 * 1024, partialResponses: 4, partialBytes: 4 * 2_000_000,
    rangeRequests: 9, bytesServed: 5 * 4 * 1024 * 1024 + 4 * 2_000_000,
  }));
  assertEq(overTheCap.results.find((r) => r.gate === 'PXcls-block-responses')?.verdict, 'fail',
    'nine block-sized fetches for one entry is a breach, whichever kind they are');

  // AN OVERSIZED BODY IS REFUSED AT ONE. This is the case the split exists to keep refusing: before it, a
  // whole-object answer to a ranged request sat in the same bucket as a harmless clipped block.
  const oversized = runBudget(base, before, after({
    oversizedResponses: 1, oversizedBytes: 40_000_000, rangeRequests: 1, bytesServed: 40_000_000,
  }));
  assertEq(oversized.results.find((r) => r.gate === 'PXcls-oversized-responses')?.verdict, 'fail',
    'a single body larger than a demand block fails');
  assertEq(oversized.results.find((r) => r.gate === 'PXcls-oversized-responses')?.measured, 1,
    'and it is reported as the count it was');
});

await test('EXECUTION: per-object verdicts use ENDPOINT-reported sizes, not the caller ordering', () => {
  // THE DEFECT THIS CLOSES, AND MY FIRST DRAFT HAD IT. `--object-sizes` is in the GATE's order; the
  // attribution array is in the endpoint's REGISTRATION order. Pairing them by position judges each object
  // against some other object's length and reports confident per-object verdicts about the wrong objects.
  // A mutation swapping one for the other passed every other test in this suite, which is why this exists.
  //
  // The two orderings are deliberately REVERSED here, and the sizes are far enough apart that judging by the
  // wrong one flips the answer.
  const endpointSizes = [40_000, 10_000_000];
  const served = [400_000, 1_000_000];
  const before = { ...QUIET_COUNTERS, objectBytes: [0, 0], objectSizes: endpointSizes };
  const after = {
    ...QUIET_COUNTERS,
    bytesServed: QUIET_COUNTERS.bytesServed + served[0]! + served[1]!,
    objectBytes: served,
    objectSizes: endpointSizes,
  };

  // Correct pairing: 400,000 against a 40,000-byte object's ceiling of 440,000 passes, and 1,000,000
  // against a 10,000,000-byte object's ceiling of 36,700,160 passes. Reversed, the second is judged against
  // 440,000 and fails.
  assertEq(plexObjectByteCeiling(endpointSizes[0]!), 440_000, 'the small object own ceiling');
  assert(served[1]! > plexObjectByteCeiling(endpointSizes[0]!),
    'and the large object traffic exceeds it, so a mispairing cannot pass unnoticed');

  const run = runBudget(['--gate', 'PXpair', '--entries', '2',
    '--object-sizes', `${endpointSizes[1]},${endpointSizes[0]}`], before, after);
  assertEq(run.status, 0, `the window is legitimate and must pass: ${run.stderr}`);
  assertEq(run.results.find((r) => r.gate === 'PXpair-provider-bytes-per-object')?.verdict, 'pass',
    'no object breached its OWN ceiling, however the caller happened to order its size list');
  assert(!run.results.some((r) => r.gate.startsWith('PXpair-provider-bytes-object-')),
    'and no per-object breach was recorded, which is what a mispairing would have produced');
  assertEq(run.results.find((r) => r.gate === 'PXpair-provider-bytes-attributed')?.verdict, 'pass',
    'while the attribution partition still balances');
});

await test('EXECUTION: a per-object breach FAILS and names the object that caused it', () => {
  // THE WHOLE POINT OF ATTRIBUTION, AND IT WAS ONLY COVERED IN THE PASSING DIRECTION. gate8's failure could
  // not say which of forty objects spent the bytes. If a breach does not now name its object, nothing has
  // actually changed except the arithmetic.
  const endpointSizes = [40_000, 10_000_000];
  const before = { ...QUIET_COUNTERS, objectBytes: [0, 0], objectSizes: endpointSizes };

  // The SMALL object is the one that runs away: 5,000,000 bytes for a 40,000-byte object, 125x its length.
  // Its own ceiling is 440,000. The aggregate would never notice — 5,000,000 sits far inside the sum of the
  // two ceilings (37,140,160) — which is exactly the confusion this replaces.
  const served = [5_000_000, 1_000_000];
  const after = {
    ...QUIET_COUNTERS,
    bytesServed: QUIET_COUNTERS.bytesServed + served[0]! + served[1]!,
    objectBytes: served, objectSizes: endpointSizes,
  };
  const run = runBudget(['--gate', 'PXrun', '--entries', '2',
    '--object-sizes', `${endpointSizes[0]},${endpointSizes[1]}`], before, after);

  const named = run.results.find((r) => r.gate === 'PXrun-provider-bytes-object-0');
  assert(named !== undefined, 'the breaching object gets a verdict of its own, identified by its ordinal');
  assertEq(named?.verdict, 'fail', 'and that verdict is a failure');
  assertEq(named?.measured, 5_000_000, 'reporting what it actually served');
  assertEq(run.results.find((r) => r.gate === 'PXrun-provider-bytes-per-object')?.verdict, 'fail',
    'and the per-object roll-up fails with it');
  assert(!run.results.some((r) => r.gate === 'PXrun-provider-bytes-object-1'),
    'while the object that behaved gets no breach verdict at all');

  // THE AGGREGATE CANNOT SEE IT, WHICH IS THE EVIDENCE THAT PER-OBJECT IS DOING THE WORK.
  assertEq(run.results.find((r) => r.gate === 'PXrun-provider-bytes')?.verdict, 'pass',
    'the aggregate ceiling passes this window, so the runaway is caught only by attribution');
});

await test('EXECUTION: unattributed bytes fail the attribution partition', () => {
  // IF THE PER-OBJECT TOTALS DO NOT ADD UP TO THE WINDOW, THE PER-OBJECT VERDICTS ARE JUDGING AN INCOMPLETE
  // PICTURE. A body served for an object the endpoint never registered would otherwise vanish: every named
  // object inside its ceiling, the aggregate inside its sum, and bytes on the wire nobody accounted for.
  const endpointSizes = [10_000_000];
  const before = { ...QUIET_COUNTERS, objectBytes: [0], objectSizes: endpointSizes };
  const after = {
    ...QUIET_COUNTERS,
    // A million bytes attributed, but two million served.
    bytesServed: QUIET_COUNTERS.bytesServed + 2_000_000,
    objectBytes: [1_000_000], objectSizes: endpointSizes,
  };
  const run = runBudget(['--gate', 'PXattr', '--entries', '1', '--object-sizes', '10000000'], before, after);

  const partition = run.results.find((r) => r.gate === 'PXattr-provider-bytes-attributed');
  assertEq(partition?.verdict, 'fail', 'the shortfall is a failure, not a rounding note');
  assertEq(partition?.measured, 1_000_000, 'reporting what was attributed...');
  assertEq(partition?.budget, 2_000_000, '...against what was served');
  // And the object that WAS attributed still passes on its own terms, which is why the partition has to be
  // a separate assertion rather than something inferred from the per-object verdicts.
  assertEq(run.results.find((r) => r.gate === 'PXattr-provider-bytes-per-object')?.verdict, 'pass',
    'every named object is inside its own ceiling, so nothing else in the phase would have noticed');
});

await test('EXECUTION: a zero window stays at zero WITH attribution present', () => {
  // THE ZERO-WINDOW PATH RUNS BEFORE THE PER-OBJECT BRANCH, so adding attribution could have quietly moved
  // the warm re-scan onto a path that no longer asserts anything. PX14 is the strongest amplification claim
  // in the gate and has already been silently unasserted once; it does not get to happen twice.
  const px14 = ['--gate', 'PX14-rescan', '--entries', '1', '--windows', '0'];
  const sizes = [10_000_000, 40_000];
  const warm = runBudget(px14,
    { ...QUIET_COUNTERS, objectBytes: [0, 0], objectSizes: sizes },
    { ...QUIET_COUNTERS, objectBytes: [0, 0], objectSizes: sizes });
  assertEq(warm.status, 0, `an untouched window still passes with attribution present: ${warm.stderr}`);
  assertEq(warm.results.find((r) => r.gate === 'PX14-rescan-provider-bytes')?.verdict, 'pass',
    'and the exact-zero byte assertion still runs');

  // ONE BYTE ATTRIBUTED TO ONE OBJECT IS STILL A FAILURE. The zero window asserts the provider was not
  // touched; attribution must not become a way to spend bytes it does not look at.
  const touched = runBudget(px14,
    { ...QUIET_COUNTERS, objectBytes: [0, 0], objectSizes: sizes },
    {
      ...QUIET_COUNTERS, bytesServed: QUIET_COUNTERS.bytesServed + 1,
      objectBytes: [1, 0], objectSizes: sizes,
    });
  assertEq(touched.results.find((r) => r.gate === 'PX14-rescan-provider-bytes')?.verdict, 'fail',
    'one attributed byte in a zero window fails');
  // The zero window emits no per-object verdicts, because it has already asserted the stronger thing.
  assert(!touched.results.some((r) => r.gate.startsWith('PX14-rescan-provider-bytes-object-')),
    'and it does not also emit per-object verdicts, which would be a weaker claim beneath a stronger one');
  assert(touched.results.some((r) => r.gate === 'PX14-rescan-provider-bytes-floor-not-applicable'),
    'while still recording why it carries no floor');
});

await test('EXECUTION: a window WITHOUT attribution fails closed rather than falling back quietly', () => {
  // THE DEFECT THIS CLOSES, AND IT IS THE ONE THIS GATE KEEPS MAKING. The per-object ceiling is what binds a
  // scan window. If the endpoint reports no attribution, the phase used to skip those verdicts and assert
  // only the aggregate — a window whose headline assertion silently did not run, reported as a pass. PX14
  // taught exactly this lesson once already; it does not get to be relearned.
  const base = ['--gate', 'PXclosed', '--entries', '1', '--object-sizes', '10000000'];
  const noAttribution = runBudget(base, QUIET_COUNTERS, { ...QUIET_COUNTERS });
  const verdict = noAttribution.results.find((r) => r.gate === 'PXclosed-provider-bytes-per-object');
  assert(verdict !== undefined, 'the per-object gate is still recorded when attribution is missing...');
  assertEq(verdict?.verdict, 'fail', '...and it FAILS, because the window is unbudgeted rather than cheap');

  // MISMATCHED LENGTHS ARE THE SAME KIND OF BROKEN, because nothing can be paired with its own size.
  const mismatched = runBudget(base,
    { ...QUIET_COUNTERS, objectBytes: [0, 0], objectSizes: [10_000_000, 40_000] },
    { ...QUIET_COUNTERS, objectBytes: [1_000, 2_000], objectSizes: [10_000_000] });
  assertEq(mismatched.results.find((r) => r.gate === 'PXclosed-provider-bytes-per-object')?.verdict, 'fail',
    'two arrays of different lengths cannot pair an object with its length, so the window fails');

  // AND A SHRINKING ARRAY MEANS THE ENDPOINT RESTARTED UNDER THE WINDOW.
  const shrunk = runBudget(base,
    { ...QUIET_COUNTERS, objectBytes: [0, 0], objectSizes: [10_000_000, 40_000] },
    { ...QUIET_COUNTERS, objectBytes: [1_000], objectSizes: [10_000_000] });
  // This one pairs cleanly, so it is caught by the continuity gate rather than the pairing gate: the arrays
  // are self-consistent, but the endpoint knew fewer objects at the end than at the start.
  assertEq(shrunk.results.find((r) => r.gate === 'PXclosed-provider-bytes-attribution-continuous')?.verdict,
    'fail', 'an endpoint that knows fewer objects than it did at the start of the window fails it');
});

await test('EXECUTION: a malformed counter array is fatal, never silently zero', () => {
  // JSON FROM A PROCESS OVER HTTP IS NOT A number[] BECAUSE A CAST SAYS SO. A string, a null or a fraction
  // reaching the arithmetic gives NaN, every `>` comparison against NaN is false, and every per-object
  // verdict PASSES while meaning nothing. That is worse than a crash, so it is a crash.
  const base = ['--gate', 'PXbad', '--entries', '1', '--object-sizes', '10000000'];
  const sizes = [10_000_000];
  for (const [broken, why] of [
    [['1000'], 'a string element'],
    [[null], 'a null element'],
    [[1000.5], 'a fractional byte count'],
    [[-5], 'a negative total'],
    [[Number.NaN], 'a NaN'],
  ] as Array<[unknown[], string]>) {
    const run = runBudget(base,
      { ...QUIET_COUNTERS, objectBytes: [0], objectSizes: sizes },
      { ...QUIET_COUNTERS, objectBytes: broken, objectSizes: sizes });
    assertEq(run.status, 1, `${why} is fatal rather than dropped`);
    assert(/objectBytes\[0\]/.test(run.stderr), `and the message names the element: ${run.stderr}`);
  }
  // A non-array where an array belongs is refused the same way.
  const notAnArray = runBudget(base,
    { ...QUIET_COUNTERS, objectBytes: [0], objectSizes: sizes },
    { ...QUIET_COUNTERS, objectBytes: 12_345 as unknown as number[], objectSizes: sizes });
  assertEq(notAnArray.status, 1, 'a scalar where the array belongs is fatal');
});

await test('EXECUTION: a per-object counter that went BACKWARDS fails rather than reading as idle', () => {
  // Cumulative totals only rise. A smaller AFTER means the endpoint restarted mid-window, and treating the
  // negative delta as "this object did nothing" is the reading most likely to be wrong AND the one that
  // passes — the same trap the aggregate byte assertion avoids by using an equality rather than a ceiling.
  const sizes = [10_000_000, 40_000];
  const run = runBudget(['--gate', 'PXreset', '--entries', '2', '--object-sizes', '10000000,40000'],
    { ...QUIET_COUNTERS, objectBytes: [5_000_000, 20_000], objectSizes: sizes },
    {
      ...QUIET_COUNTERS, bytesServed: QUIET_COUNTERS.bytesServed + 1_000,
      objectBytes: [1_000_000, 21_000], objectSizes: sizes,
    });
  const backwards = run.results.find((r) => r.gate === 'PXreset-provider-bytes-object-0');
  assertEq(backwards?.verdict, 'fail', 'the object whose counter fell is failed by name');
  assert((backwards?.measured ?? 0) < 0, 'and its negative delta is reported rather than clamped to zero');
  assertEq(run.results.find((r) => r.gate === 'PXreset-provider-bytes-per-object')?.verdict, 'fail',
    'and the roll-up fails with it');
});

await test('EXECUTION: a BEFORE snapshot without attribution is fatal, not treated as zero history', () => {
  // THE DEFECT THIS CLOSES. `readCounterArray(before, ...) ?? []` read a MISSING array as "this endpoint had
  // served nothing yet", which is a different claim from "the field is absent". Every AFTER total would then
  // be attributed to this window, so a window opened late in a run inherits every earlier phase's traffic —
  // and the error always runs toward a LARGER delta being charged here, which is the direction that turns a
  // clean window into a spurious breach and an over-budget one into someone else's fault.
  const sizes = [10_000_000];
  const run = runBudget(['--gate', 'PXhist', '--entries', '1', '--object-sizes', '10000000'],
    { ...QUIET_COUNTERS },                                        // no objectBytes at all
    { ...QUIET_COUNTERS, objectBytes: [9_000_000], objectSizes: sizes });
  assertEq(run.status, 1, 'the phase refuses to guess at missing history');
  assert(/BEFORE counters do not/.test(run.stderr), `and says why: ${run.stderr}`);

  // THE LEGITIMATE CASE IS AN EXPLICIT ZERO ARRAY, which is a statement rather than an absence: an endpoint
  // that has registered objects and served none of them yet.
  const fresh = runBudget(['--gate', 'PXhist', '--entries', '1', '--object-sizes', '10000000'],
    { ...QUIET_COUNTERS, objectBytes: [0], objectSizes: sizes },
    { ...QUIET_COUNTERS, bytesServed: QUIET_COUNTERS.bytesServed + 1_000, objectBytes: [1_000],
      objectSizes: sizes });
  assertEq(fresh.status, 0, `an explicit zero history is accepted: ${fresh.stderr}`);
  assertEq(fresh.results.find((r) => r.gate === 'PXhist-provider-bytes-per-object')?.verdict, 'pass',
    'and the window is measured against it');
});

await test('the per-object ceiling SATURATES at one demand block, not at any crossover', () => {
  // THE STALE ARITHMETIC THIS CLOSES. The prose said the two halves agreed at `BYTES_PER_ENTRY / 2`, about
  // 17.5 MiB. That was the point where the RETIRED 2x clamp met the envelope. There is no clamp now, so
  // there is no such point: the ceiling is `BLOCK x min(CHUNK, size) + SMALL x min(WINDOW, size)`, and both
  // terms stop growing once the object can serve a full block.
  const CHUNK = PLEX_READ_GEOMETRY.CHUNK_BYTES;
  const WINDOW = PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES;
  const saturation = Math.max(CHUNK, WINDOW);
  assertEq(saturation, CHUNK, 'the later of the two terms to saturate is the demand block');
  assertEq(saturation, 4 * 1024 * 1024, 'which is 4 MiB');

  assertEq(plexObjectByteCeiling(saturation), PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY,
    'exactly one demand block already earns the whole envelope');
  assert(plexObjectByteCeiling(saturation - 1) < PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY,
    'one byte less does not');
  for (const size of [saturation, saturation + 1, 17_500_000, 105_406_871, 4 * 1024 * 1024 * 1024]) {
    assertEq(plexObjectByteCeiling(size), PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY,
      `every object at or above saturation earns the same envelope, at ${size}`);
  }
  // THE OLD FIGURE IS NOT THE SATURATION POINT, and asserting that is the whole content of this test.
  const retiredCrossover = PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY / 2;
  assert(retiredCrossover > saturation,
    'the retired 17.5 MiB crossover is far above the real saturation point of 4 MiB');
  assertEq(plexObjectByteCeiling(retiredCrossover), plexObjectByteCeiling(saturation),
    'and the ceiling has been flat between them all along, so it marked nothing');

  // NO SOURCE MAY STATE IT ANY MORE.
  for (const source of SCAN_MODEL_SOURCES) {
    const text = withoutBanDeclarations(read(source));
    assert(!/17\.5 ?MiB/.test(text), `${source} no longer names the retired crossover`);
    assert(!/BYTES_PER_ENTRY \/ 2/.test(text), `${source} no longer computes it`);
  }
});

await test('EXECUTION: per-object CLASS caps are asserted, not just per-object bytes', () => {
  // COLUMN SUMS ARE AGGREGATE ATTRIBUTION; THESE ARE THE PER-OBJECT ARITHMETIC. The byte ceiling is
  // BLOCK x min(4 MiB, size) + SMALL x min(1 MiB, size). Checking only its total leaves both terms
  // unchecked: a short object can make far more block-sized fetches than BLOCK permits and still sit inside
  // the byte figure, because each fetch is small when the object is small.
  //
  // EVERY FIXTURE BELOW IS INTERNALLY TRUTHFUL, which matters more than it sounds. A window that moves a
  // class count without moving its class BYTES, its bytesServed and its accountedResponses would fail the
  // two partition assertions for reasons unrelated to the cap under test — and a mutation that fails for
  // the wrong reason proves nothing about the assertion it was written for.
  const CHUNK = 4 * 1024 * 1024;
  const size = 10_000_000;
  const sizes = [size];
  const zero = [0];
  const base = ['--gate', 'PXcap', '--entries', '1', '--object-sizes', String(size)];

  /** One object serves N full blocks, M bodies of partialLen, and S bodies of smallLen. */
  const serve = (chunks: number, partials: number, partialLen: number, smalls = 0, smallLen = 4096) => {
    const bytes = chunks * CHUNK + partials * partialLen + smalls * smallLen;
    const responses = chunks + partials + smalls;
    return runBudget(base,
      { ...QUIET_COUNTERS, objectBytes: zero, objectSizes: sizes, objectChunk: zero, objectSmall: zero,
        objectPartial: zero, objectOversized: zero },
      {
        ...QUIET_COUNTERS,
        bytesServed: QUIET_COUNTERS.bytesServed + bytes,
        accountedResponses: QUIET_COUNTERS.accountedResponses + responses,
        rangeRequests: QUIET_COUNTERS.rangeRequests + responses,
        chunkResponses: QUIET_COUNTERS.chunkResponses + chunks,
        chunkBytes: QUIET_COUNTERS.chunkBytes + chunks * CHUNK,
        partialResponses: QUIET_COUNTERS.partialResponses + partials,
        partialBytes: QUIET_COUNTERS.partialBytes + partials * partialLen,
        smallResponses: QUIET_COUNTERS.smallResponses + smalls,
        smallBytes: QUIET_COUNTERS.smallBytes + smalls * smallLen,
        objectBytes: [bytes], objectSizes: sizes,
        objectChunk: [chunks], objectSmall: [smalls], objectPartial: [partials], objectOversized: zero,
      });
  };
  const gateOf = (run: ReturnType<typeof runBudget>, id: string) =>
    run.results.find((r) => r.gate === id);

  // NINE BLOCK-CLASS FETCHES FOR ONE OBJECT, all clipped and individually well under a block. The bytes stay
  // inside the per-object ceiling, so the byte check alone would pass this window.
  const nineClipped = serve(0, 9, 2_000_000);
  assertEq(gateOf(nineClipped, 'PXcap-provider-block-class-object-0')?.verdict, 'fail',
    'nine block-sized fetches for one object breaches BLOCK');
  assertEq(gateOf(nineClipped, 'PXcap-provider-block-class-object-0')?.measured, 9, 'reported as its count');
  assertEq(gateOf(nineClipped, 'PXcap-provider-block-class-object-0')?.budget, PLEX_SCAN_ENVELOPE.BLOCK,
    'against the cap the byte formula uses');
  assertEq(gateOf(nineClipped, 'PXcap-provider-bytes-object-0'), undefined,
    'while the BYTE ceiling passes — 18 MB is inside 36,700,160 — which is why the class caps exist');
  assertEq(gateOf(nineClipped, 'PXcap-provider-classes-per-object')?.verdict, 'fail',
    'and the CLASS roll-up carries it...');
  assertEq(gateOf(nineClipped, 'PXcap-provider-bytes-per-object')?.verdict, 'pass',
    '...while the BYTE roll-up stays truthful about having found nothing');
  // The partitions must be undisturbed, or this fixture would be failing for the wrong reason.
  assertEq(gateOf(nineClipped, 'PXcap-request-shape-accounts-for-every-request')?.verdict, 'pass',
    'the request partition is unaffected');
  assertEq(gateOf(nineClipped, 'PXcap-request-shape-accounts-for-every-byte')?.verdict, 'pass',
    'and so is the byte partition');

  // FULL AND CLIPPED SHARE THE ALLOWANCE. 5 + 4 = 9 breaches; 4 + 4 = 8 is exactly the cap and does not.
  // Both stay under the 36,700,160 ceiling: 5 x 4 MiB + 4 x 1.5 MB = 27,262,976.
  const nineMixed = serve(5, 4, 1_500_000);
  assertEq(gateOf(nineMixed, 'PXcap-provider-block-class-object-0')?.verdict, 'fail',
    '5 full + 4 clipped is nine block-sized fetches for one object');
  assertEq(gateOf(nineMixed, 'PXcap-provider-bytes-object-0'), undefined,
    'and its bytes are inside the ceiling, so only the class cap catches it');
  const atCap = serve(4, 4, 1_500_000);
  assertEq(gateOf(atCap, 'PXcap-provider-block-class-object-0'), undefined,
    '4 + 4 is exactly the cap, so no breach is recorded');
  assertEq(gateOf(atCap, 'PXcap-provider-classes-per-object')?.verdict, 'pass', 'and the roll-up passes');

  // SMALL, per object: four probe-window reads against a cap of three.
  const fourSmall = serve(0, 0, 0, 4);
  assertEq(gateOf(fourSmall, 'PXcap-provider-small-class-object-0')?.verdict, 'fail',
    'four probe-window reads for one object breaches SMALL');

  // OVERSIZED, PER OBJECT AND AT ONE. The aggregate oversized assertion has existed since the split, but it
  // says nothing about the per-object COLUMN or the per-object cap — a body larger than a demand block
  // attributed to an object has to fail on that object, by name, or the column is decorative.
  const oversizedBytes = 9_000_000;
  const oversized = runBudget(base,
    { ...QUIET_COUNTERS, objectBytes: zero, objectSizes: sizes, objectChunk: zero, objectSmall: zero,
      objectPartial: zero, objectOversized: zero },
    {
      ...QUIET_COUNTERS,
      bytesServed: QUIET_COUNTERS.bytesServed + oversizedBytes,
      oversizedResponses: QUIET_COUNTERS.oversizedResponses + 1,
      oversizedBytes: QUIET_COUNTERS.oversizedBytes + oversizedBytes,
      accountedResponses: QUIET_COUNTERS.accountedResponses + 1,
      rangeRequests: QUIET_COUNTERS.rangeRequests + 1,
      objectBytes: [oversizedBytes], objectSizes: sizes,
      objectChunk: zero, objectSmall: zero, objectPartial: zero, objectOversized: [1],
    });
  assertEq(gateOf(oversized, 'PXcap-provider-oversized-class-object-0')?.verdict, 'fail',
    'one oversized body attributed to an object fails on that object at one');
  assertEq(gateOf(oversized, 'PXcap-provider-oversized-class-object-0')?.measured, 1, 'reported as one');
  assertEq(gateOf(oversized, 'PXcap-provider-objectOversized-reconciles')?.verdict, 'pass',
    'while the column reconciles with the aggregate, so the failure is the CAP and not the attribution');
  assertEq(gateOf(oversized, 'PXcap-provider-classes-per-object')?.verdict, 'fail',
    'and the class roll-up carries it');

  // A ZERO-BYTE WINDOW WHOSE CLASSES MOVED. A zero-length body is classified SMALL, so this object is
  // ACTIVE with a zero byte delta — the case that used to be skipped entirely.
  const zeroLength = serve(0, 0, 0, 4, 0);
  assertEq(gateOf(zeroLength, 'PXcap-provider-small-class-object-0')?.verdict, 'fail',
    'an object that served four zero-length bodies is still checked against SMALL');
});

await test('EXECUTION: the class columns fail closed on absence, misalignment and reset', () => {
  const sizes = [10_000_000, 40_000];
  const zero = [0, 0];
  const full = { objectBytes: zero, objectSizes: sizes, objectChunk: zero, objectSmall: zero,
    objectPartial: zero, objectOversized: zero };
  const base = ['--gate', 'PXcls2', '--entries', '2', '--object-sizes', '10000000,40000'];
  // ONE TRUTHFUL SMALL RESPONSE, ATTRIBUTED TO OBJECT 0. Moving bytes without the matching class, byte-class,
  // accounted and arrival counters would fail the partitions, and a structural mutation that fails for a
  // partition reason proves nothing about the structural check it was written for.
  const served = {
    ...QUIET_COUNTERS,
    bytesServed: QUIET_COUNTERS.bytesServed + 1_000,
    smallResponses: QUIET_COUNTERS.smallResponses + 1,
    smallBytes: QUIET_COUNTERS.smallBytes + 1_000,
    accountedResponses: QUIET_COUNTERS.accountedResponses + 1,
    rangeRequests: QUIET_COUNTERS.rangeRequests + 1,
    objectBytes: [1_000, 0], objectSizes: sizes, objectChunk: zero, objectSmall: [1, 0],
    objectPartial: zero, objectOversized: zero,
  };

  // A MISSING BEFORE COLUMN. This is the `?? []` defect, one function below where it was already fixed
  // once: absent history read as zero charges every response the endpoint ever classified to this window.
  const noBefore = runBudget(base,
    { ...QUIET_COUNTERS, objectBytes: zero, objectSizes: sizes, objectSmall: zero,
      objectPartial: zero, objectOversized: zero },
    served);
  assertEq(noBefore.results.find((r) => r.gate === 'PXcls2-provider-objectChunk-present')?.verdict, 'fail',
    'a class column missing from BEFORE fails the window');

  // A MISSING AFTER COLUMN.
  const noAfter = runBudget(base, { ...QUIET_COUNTERS, ...full },
    { ...served, objectPartial: undefined as unknown as number[] });
  assertEq(noAfter.results.find((r) => r.gate === 'PXcls2-provider-objectPartial-present')?.verdict, 'fail',
    'a class column missing from AFTER fails the window');

  // A TRUNCATED BEFORE COLUMN FOR AN ALREADY-REGISTERED OBJECT. Both byte columns have two entries, so no
  // object was registered during the window; a one-entry class column therefore drops an object's history
  // and `?? 0` would re-charge its lifetime class traffic here. It must be an EQUALITY against
  // objectBytesBefore, not merely no longer than AFTER.
  const truncated = runBudget(base,
    { ...QUIET_COUNTERS, ...full, objectChunk: [3] },
    served);
  assertEq(truncated.results.find((r) => r.gate === 'PXcls2-provider-objectChunk-aligned')?.verdict, 'fail',
    'a BEFORE class column shorter than the BEFORE byte column fails');

  // AND A LEGITIMATELY SHORTER BEFORE IS NOT THIS CASE: an object registered during the window is absent
  // from objectBytesBefore and from every class BEFORE column together, so the lengths still match.
  const grew = runBudget(base,
    { ...QUIET_COUNTERS, objectBytes: [0], objectSizes: [10_000_000], objectChunk: [0], objectSmall: [0],
      objectPartial: [0], objectOversized: [0] },
    served);
  assert(!grew.results.some((r) => r.gate.endsWith('-aligned') && r.verdict === 'fail'),
    'an object registered during the window is legitimate and does not trip the alignment rule');

  // A CLASS COUNTER THAT WENT BACKWARDS.
  const reset = runBudget(base,
    { ...QUIET_COUNTERS, ...full, objectChunk: [4, 0] },
    { ...served, objectChunk: [1, 0] });
  assertEq(reset.results.find((r) => r.gate === 'PXcls2-provider-objectChunk-object-0')?.verdict, 'fail',
    'a per-object class counter that fell across the window fails by name');
});

await test('EXECUTION: a zero window forces the SPLIT classes to zero as well', () => {
  // The split added two counters. A zero window that forgot either of them would be a window asserting
  // "nothing happened" while a whole class of response went unexamined — the PX14 defect, reintroduced.
  const px14 = ['--gate', 'PX14-rescan', '--entries', '1', '--windows', '0'];
  const warm = runBudget(px14, QUIET_COUNTERS, { ...QUIET_COUNTERS });
  assertEq(warm.status, 0, `a truly warm window passes: ${warm.stderr}`);
  for (const cls of ['block', 'small', 'oversized', 'bodyless']) {
    const result = warm.results.find((r) => r.gate === `PX14-rescan-${cls}-responses`);
    assert(result !== undefined, `the ${cls} class is asserted even in a zero window`);
    assertEq(result?.verdict, 'pass', `and passes at zero: ${cls}`);
  }
  // ...AND EACH ONE FAILS IF IT MOVED. One per class, so a missing assertion cannot hide behind a sibling.
  for (const [counter, gateId] of [
    ['chunkResponses', 'PX14-rescan-block-responses'],
    ['partialResponses', 'PX14-rescan-block-responses'],
    ['smallResponses', 'PX14-rescan-small-responses'],
    ['oversizedResponses', 'PX14-rescan-oversized-responses'],
    ['bodylessResponses', 'PX14-rescan-bodyless-responses'],
  ] as Array<[string, string]>) {
    const moved = runBudget(px14, QUIET_COUNTERS, {
      ...QUIET_COUNTERS,
      [counter]: ((QUIET_COUNTERS as Record<string, number>)[counter] ?? 0) + 1,
      rangeRequests: QUIET_COUNTERS.rangeRequests + 1,
    });
    assertEq(moved.results.find((r) => r.gate === gateId)?.verdict, 'fail',
      `a single ${counter} in a zero window fails ${gateId}`);
  }
  // And the byte assertion is still exact and still outside the object-size guard.
  const bytes = runBudget(px14, QUIET_COUNTERS,
    { ...QUIET_COUNTERS, bytesServed: QUIET_COUNTERS.bytesServed + 1 });
  assertEq(bytes.results.find((r) => r.gate === 'PX14-rescan-provider-bytes')?.verdict, 'fail',
    'one byte in a zero window is still a failure');
});

await test('a non-zero budget window REFUSES to run without valid object sizes', () => {
  // THE FOOTGUN THIS CLOSES. The sizes were parsed with a `.filter()` that dropped anything unparseable, so
  // `1000,,2000` silently became a two-object denominator, `abc,2000` a one-object one, and an unset shell
  // variable an empty list - which skipped the byte ceiling entirely. Every one of those makes the budget
  // LOOSER than the gate reads as, from a typo, invisibly. A denominator is not a place to be forgiving.
  const base = ['--gate', 'PXtest', '--entries', '1'];

  const missing = runBudget(base, QUIET_COUNTERS, { ...QUIET_COUNTERS });
  assertEq(missing.status, 1, 'a window with no --object-sizes is refused');
  assert(/--object-sizes is required/.test(missing.stderr), `and says why: ${missing.stderr}`);
  assert(!missing.results.some((r) => r.gate === 'PXtest-provider-bytes'),
    'and does not quietly report a phase with no byte assertion in it');

  for (const [sizes, why] of [
    ['1000,,2000', 'an empty token'],
    ['abc,2000', 'a non-numeric token'],
    ['1000,0', 'a zero size'],
    ['1000,-5', 'a negative size'],
    ['1000,NaN', 'a NaN token'],
    ['   ', 'nothing but whitespace'],
  ] as Array<[string, string]>) {
    const run = runBudget([...base, '--object-sizes', sizes], QUIET_COUNTERS, { ...QUIET_COUNTERS });
    assertEq(run.status, 1, `${why} is fatal rather than dropped (${sizes})`);
  }

  // AND THE VALID FORM STILL WORKS, with every named object in the denominator.
  const ok = runBudget([...base, '--object-sizes', '1000,2000'],
    QUIET_COUNTERS, { ...QUIET_COUNTERS, bytesServed: QUIET_COUNTERS.bytesServed + 1_000 });
  assertEq(ok.status, 0, `a well-formed list runs: ${ok.stderr}`);
  assertEq(ok.results.find((r) => r.gate === 'PXtest-provider-bytes')?.verdict, 'pass',
    'and the byte ceiling is asserted');
  // The two objects are under a probe window, so each is capped at 11 x its own length: 11,000 + 22,000 =
  // 33,000. A window that served 40,000 bytes for 3,000 bytes of object is a runaway and fails.
  assertEq(plexScanByteCeiling([1_000, 2_000]), 33_000, 'the aggregate is the sum of the two ceilings');
  const over = runBudget([...base, '--object-sizes', '1000,2000'],
    QUIET_COUNTERS, { ...QUIET_COUNTERS, bytesServed: QUIET_COUNTERS.bytesServed + 40_000 });
  assertEq(over.results.find((r) => r.gate === 'PXtest-provider-bytes')?.verdict, 'fail',
    'and it still has teeth: 40,000 bytes against a 33,000-byte ceiling fails');
});

await test('the byte CEILING is asserted per object; the FLOOR is still an aggregate', () => {
  // AN EARLIER VERSION OF THIS SUITE CLAIMED THE OPPOSITE, and the claim was false. Both the ceiling and the
  // floor are sums checked against ONE counter - `bytesServed` for the whole window - so nothing here can
  // distinguish "each object cost its own share" from "one object cost everything and the rest cost
  // nothing". This test records what the budget DOES buy and what it does not, so neither is overstated.
  const tiny = Array.from({ length: 38 }, () => 40_000);
  const large = 105_406_871;
  const sizes = [large, ...tiny];

  // WHAT IT BUYS: a far tighter allowance than a pooled size would give. Pooling would grant every entry the
  // full envelope, because a pooled total is above one demand block and so saturates for every entry.
  const derived = plexScanByteCeiling(sizes);
  const pooledStyle = sizes.length * PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY;
  assert(derived < pooledStyle / 10, `the derived aggregate (${derived}) is far under a pooled one`);
  assertEq(derived, PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY + 38 * plexObjectByteCeiling(40_000),
    'the large object contributes the full envelope and each tiny one the caps against its own length');

  // WHAT IT DOES NOT BUY: attribution. A window in which the large object alone consumed the whole
  // allowance, and the thirty-eight tiny entries were never opened, PASSES both the ceiling and the floor.
  const floor = sizes.reduce(
    (total, size) => total + Math.min(size, PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES), 0);
  assert(floor < PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY,
    'the whole floor is smaller than what the large object alone may spend, so the other thirty-eight '
    + 'can be paid for by it - exactly the cross-subsidy this instrument cannot detect');
  const oneObjectSpentEverything = derived;
  assert(oneObjectSpentEverything <= derived && oneObjectSpentEverything >= floor,
    'and such a window sits inside the ceiling and above the floor, so it passes');

  // AND EVERY SOURCE SAYS SO, rather than claiming a per-object guarantee it cannot deliver.
  for (const source of ['src/core/projection/plex-dataplane.ts', 'src/ops/projection-plex-dataplane-cli.ts',
    'docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md']) {
    const text = read(source);
    assert(/aggregate/i.test(text), `${source} calls the budget an aggregate`);
    assert(/per-reference|attribution/i.test(text), `${source} names what closing it would require`);
    assert(!/cannot be cross-subsidised|not cross-subsidised/i.test(text),
      `${source} does not claim cross-subsidy is prevented`);
  }
  assert(/Cross-subsidy in the byte FLOOR/.test(read('docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md')),
    'and the document lists the remaining floor cross-subsidy under what is still not proved');
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

await test('the UNCLAMPED envelope component is derived from the caps and cannot drift from them', () => {
  // WHAT THIS DOES AND DOES NOT SAY, because an earlier version of this test overstated it.
  //
  // IT SAYS: the envelope COMPONENT of the byte ceiling — `BYTES_PER_ENTRY`, the term before the clamp — is
  // exactly what the class caps permit. A scan serving eight demand blocks and three probe windows satisfies
  // every request cap, and on an object at or above one demand block it also satisfies the byte ceiling, so the two
  // agree there. Computing it from the same bindings is what stops them drifting when a cap moves.
  //
  // IT DOES NOT SAY that every object gets 35 MiB. The same caps yield LESS for an object shorter than a
  // demand block, because it cannot serve one: a 40 KB entry is held to eleven reads of its own length,
  // 444,532 bytes. That is one rule evaluated against two objects, not two rules.
  //
  // THE REVIEW THAT SPECIFIED THIS ENVELOPE NAMED 35,651,584, AND I HAD PROPOSED THAT NUMBER. It is one
  // probe window short of the caps: 34 MiB where they permit 35. Deriving it makes the mistake unrepeatable
  // rather than merely fixed once.
  const derived = PLEX_SCAN_ENVELOPE.BLOCK * PLEX_READ_GEOMETRY.CHUNK_BYTES
    + PLEX_SCAN_ENVELOPE.SMALL * PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES;
  assertEq(PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY, derived, 'the envelope is exactly what the caps permit');
  assertEq(derived, 36_700_160, 'which is 35 MiB');
  assert(PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY !== 35_651_584,
    'and NOT the 34 MiB figure, which would have been below the caps');
  // AN OBJECT AT OR ABOVE A DEMAND BLOCK GETS THE FULL ENVELOPE; a smaller one gets the caps evaluated
  // against its own length, which is less. Neither is a separate rule — both are this same arithmetic.
  assertEq(plexScanByteCeiling([PLEX_READ_GEOMETRY.CHUNK_BYTES * 4]), derived,
    'a large object gets exactly the envelope the caps permit');
  assert(plexScanByteCeiling([40_000]) < derived,
    'while a small one is bounded by its own length, because it cannot serve a full block');
});

await test('every request class is capped separately, so a total cannot be spent as demand blocks', () => {
  assertEq(PLEX_SCAN_ENVELOPE.BLOCK, 8, 'block: full and clipped demand blocks together');
  assertEq(PLEX_SCAN_ENVELOPE.SMALL, 3, 'small');
  assertEq(PLEX_SCAN_ENVELOPE.OVERSIZED, 0, 'oversized');
  assertEq(PLEX_SCAN_ENVELOPE.BODYLESS, 0, 'bodyless');
  assertEq(PLEX_SCAN_ENVELOPE.TOTAL, 11, 'total');
  assertEq(PLEX_SCAN_ENVELOPE.TOTAL, PLEX_SCAN_ENVELOPE.BLOCK + PLEX_SCAN_ENVELOPE.SMALL,
    'and the total is exactly their sum, not an independent number');
  // THE PROPERTY THE PER-CLASS CAPS EXIST FOR. Eleven requests spent as eleven demand blocks would be 44 MiB;
  // the block cap makes that unreachable, and the byte envelope agrees.
  const asAllBlocks = PLEX_SCAN_ENVELOPE.TOTAL * PLEX_READ_GEOMETRY.CHUNK_BYTES;
  assert(asAllBlocks > PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY,
    'spending the whole total on demand blocks would exceed the byte envelope...');
  const ceilings = plexScanRequestCeilings(1);
  assert(ceilings.block < ceilings.total, '...and the block cap is what makes it unreachable');
  // Caps scale per entry; the zero-response classes do not, because zero times anything is still zero.
  assertEq(plexScanRequestCeilings(40).block, 320, 'block scales with entries');
  assertEq(plexScanRequestCeilings(40).small, 120, 'and so does small');
  assertEq(plexScanRequestCeilings(40).oversized, 0, 'oversized stays zero however many entries there are');
  assertEq(plexScanRequestCeilings(40).bodyless, 0, 'and so does bodyless');
});

await test('a clipped block spends the SAME allowance as a full one, and cannot earn a second', () => {
  // WHAT gate7 TAUGHT, AND THE SHAPE OF THE FIX. Its corpus window served 0 full blocks and 13 CLIPPED ones
  // and failed a budget that asserted the clipped class could not exist. It can, legitimately:
  // readpath.demandBlock clips a block to the gap between cached probe windows, so a read bounded by cached
  // data returns less than a full block. The fix folds both into ONE cap rather than giving the new class
  // its own, because two caps of 8 would let an entry spend sixteen block-sized fetches.
  const ceilings = plexScanRequestCeilings(1);
  assertEq(ceilings.block, 8, 'one entry may make eight block-sized fetches in total');
  assert(!Object.prototype.hasOwnProperty.call(ceilings, 'chunk')
    && !Object.prototype.hasOwnProperty.call(ceilings, 'partial'),
    'and there is no separate allowance for either kind, which is what stops them being additive');

  // THE BYTE ENVELOPE DID NOT MOVE, which is the property that makes admitting the class safe: a clipped
  // block is bounded ABOVE by a full one, so the worst case is unchanged.
  assertEq(PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY, 36_700_160, 'still exactly 35 MiB per entry');

  // AND gate7's MEASUREMENT SITS NOWHERE NEAR THE CAP, so nothing was widened to accommodate it.
  const gate7CorpusEntries = 40;
  const gate7BlockResponses = 0 + 13;
  assert(gate7BlockResponses <= plexScanRequestCeilings(gate7CorpusEntries).block,
    'the gate7 corpus window, 13 block-class responses across 40 entries, fits the unchanged cap');
  assert(gate7BlockResponses * 24 < plexScanRequestCeilings(gate7CorpusEntries).block,
    'with more than an order of magnitude to spare: 0.33 per entry against an allowance of 8');
  // The other gate7 windows, at the per-entry cap rather than the per-library one.
  for (const [full, clipped, where] of [[4, 0, 'PX9, cold anchor'], [4, 0, 'PX9c, cold large object'],
    [0, 0, 'PX12b and PX14, fully warm']] as Array<[number, number, string]>) {
    assert(full + clipped <= plexScanRequestCeilings(1).block, `${where} fits the block cap`);
  }
});

await test('the window COUNT and the measured MAXIMUM are computed, and no prose restates them wrongly', () => {
  // THE DEFECT THIS CLOSES, WHICH HAD ALREADY HAPPENED TWICE. The provenance was prose: "eight instrumented
  // windows", "5 is the highest measured", "4 in six quiet windows". Each is a claim about a dataset that
  // existed nowhere, so nothing could check it. By the time gate7 added five windows the contract said TEN
  // and the truth was THIRTEEN, and the operator note said "4 in six quiet windows" while SEVEN windows had
  // measured 4. Both survived a full review. The observations are now the data and every count and maximum
  // is derived from them.
  const counts = plexInstrumentedWindowCounts();
  assertEq(counts.total, PLEX_INSTRUMENTED_SCAN_WINDOWS.length, 'the total is the array length, not a claim');
  assertEq(counts.diagnostic + counts.gate, counts.total, 'and the two sources partition it');
  assert(counts.gate > 0, 'gate7 contributed instrumented windows, which the earlier prose omitted');

  // gate6 IS NOT IN THE DATASET, because it has no class breakdown to contribute.
  assert(!PLEX_INSTRUMENTED_SCAN_WINDOWS.some((w) => /gate6/i.test(w.label) || w.source === 'gate7'
    && /gate6/i.test(w.label)), 'gate6 is not counted among instrumented windows');
  assertEq(PLEX_GATE6_COMPATIBLE_BLOCKS.MEASURED, false, 'and it is flagged as not measured');
  assertEq(PLEX_GATE6_COMPATIBLE_BLOCKS.BLOCKS * PLEX_READ_GEOMETRY.CHUNK_BYTES
    + 3 * PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES, PLEX_GATE6_COMPATIBLE_BLOCKS.BYTES,
    'its inferred decomposition really does reproduce its byte total, which is why it is compatible');

  // THE CAP MUST SIT ABOVE EVERY MEASURED FIGURE. This is the check that turns the dataset into a guard: a
  // future window measuring more than the cap makes this fail here rather than in a thirty-minute gate.
  const highestBlocks = plexHighestMeasuredPerEntry('blocks');
  assert(PLEX_SCAN_ENVELOPE.BLOCK > highestBlocks,
    `the block cap ${PLEX_SCAN_ENVELOPE.BLOCK} is above the highest measured ${highestBlocks} per entry`);
  assert(PLEX_SCAN_ENVELOPE.SMALL >= plexHighestMeasuredPerEntry('small'),
    'and the small cap is at or above its own highest measurement');
  assertEq(plexHighestMeasuredPerEntry('oversized'), 0, 'oversized has never been measured above zero...');
  assertEq(PLEX_SCAN_ENVELOPE.OVERSIZED, 0, '...which is why it is asserted at exactly zero');
  assertEq(plexHighestMeasuredPerEntry('bodyless'), 0, 'and neither has bodyless');

  // EVERY RECORDED WINDOW FITS THE CAPS IT IS THE EVIDENCE FOR. If one did not, the caps would be a fiction.
  for (const window of PLEX_INSTRUMENTED_SCAN_WINDOWS) {
    const ceilings = plexScanRequestCeilings(window.entries);
    assert(window.blocks <= ceilings.block, `${window.label}: ${window.blocks} blocks fits the cap`);
    assert(window.small <= ceilings.small, `${window.label}: ${window.small} small fits the cap`);
    assertEq(window.oversized, ceilings.oversized, `${window.label}: no oversized responses`);
    assertEq(window.bodyless, ceilings.bodyless, `${window.label}: no bodyless responses`);
  }

  // THE OPERATOR-FACING NOTE INTERPOLATES THE DERIVED FIGURES rather than spelling them out. A literal count
  // in that string is the exact thing that drifted, so its absence is asserted.
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  const budget = cli.split("case 'budget':")[1]?.split("case 'traffic-window'")[0] ?? '';
  assert(/plexHighestMeasuredPerEntry\('blocks'\)/.test(budget),
    'the watchdog note derives its maximum');
  assert(/plexInstrumentedWindowCounts\(\)\.total/.test(budget), 'and its window count');
  assert(/PLEX_GATE6_COMPATIBLE_BLOCKS\.BLOCKS/.test(budget), 'and names the inferred figure as a constant');
  assert(!/six quiet windows|eight instrumented|ten instrumented/i.test(budget),
    'and spells no count out in prose');
});

await test('the DOCUMENT quotes the same derived count and maximum as the code', () => {
  // A document is prose by nature, so it cannot compute — but it can be held to the computed values. These
  // are the two numbers that drifted, so these are the two the document is checked on.
  const doc = read('docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md');
  const counts = plexInstrumentedWindowCounts();
  const highest = plexHighestMeasuredPerEntry('blocks');

  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
    'twenty', 'twenty-one', 'twenty-two', 'twenty-three'];
  const spelled = (n: number): string => words[n] ?? String(n);

  // THE COUNT. Digits or a word, "instrumented windows" or "windows in all" — the phrasing is the
  // document's business. Naming a DIFFERENT total is not.
  const total = `(${counts.total}|${spelled(counts.total)})`;
  assert(new RegExp(`${total}\\s+(instrumented\\s+)?windows`, 'i').test(doc),
    `the document names ${counts.total} windows, which is what the dataset holds`);
  // ...and no stale TOTAL survives in either phrasing. Only the two forms that carry a total are rejected,
  // so the document stays free to count a SUBSET — "the two cold single-object windows" is not a total.
  for (let wrong = 1; wrong <= 23; wrong += 1) {
    if (wrong === counts.total) continue;
    const other = `(${wrong}|${spelled(wrong)})`;
    for (const form of [`${other}\\s+instrumented\\s+windows`, `${other}\\s+windows in all`]) {
      assert(!new RegExp(form, 'i').test(doc), `no stale total of ${wrong} windows survives as "${form}"`);
    }
  }
  // AND THE SUBSET ARITHMETIC IS SPELLED OUT, because eight diagnostic rows above a two-row gate7 table
  // reads as ten unless the document says what the other three are. It names them.
  for (const named of ['PX9b', 'PX12b', 'PX14']) {
    assert(doc.includes(named), `the document names ${named}, a recorded window that is in no table`);
  }

  // NO SOURCE MAY CALL THE SMALL CAP AN INVARIANT. Three is the highest figure measured, not a constant of
  // Plex's probe plan: gate7's PX9 measured ONE on the cold anchor, and the corpus window averaged 1.025 per
  // entry, because a probe plan already partly cached costs fewer probe reads. Calling the cap unvarying
  // said a window measuring less was impossible, which the dataset in this very repository contradicts.
  const belowTheCap = PLEX_INSTRUMENTED_SCAN_WINDOWS
    .filter((w) => w.small / Math.max(1, w.entries) < PLEX_SCAN_ENVELOPE.SMALL && w.small > 0);
  assert(belowTheCap.length > 0,
    'at least one recorded window measured fewer probe reads than the cap, which is why it is a maximum');
  assert(belowTheCap.some((w) => w.label.startsWith('PX9,')),
    'and PX9 is one of them, at 1 probe read for a cold 14.0 MB object');
  for (const source of [...SCAN_MODEL_SOURCES, 'test/projection-plex-dataplane.ts']) {
    const text = withoutBanDeclarations(read(source));
    assert(!/invariant at 3|measured invariant|invariant, per entry|3 per entry in every/i.test(text),
      `${source} calls the small cap a measured maximum rather than an invariant`);
  }

  // THE MAXIMUM, in the cap table's basis column.
  assert(doc.includes(`${highest} is the highest **measured**`),
    `the class table names ${highest} as the highest measured figure`);
  assert(doc.includes(`${PLEX_GATE6_COMPATIBLE_BLOCKS.BLOCKS} is the **inferred**`),
    `and ${PLEX_GATE6_COMPATIBLE_BLOCKS.BLOCKS} as the inferred one, kept distinct from it`);
  assert(doc.includes(`**${PLEX_SCAN_ENVELOPE.BLOCK}**`), 'and the cap itself');
});

await test('the chunk cap separates what was MEASURED from what is only COMPATIBLE with a measurement', () => {
  // THE CORRECTION THIS ENFORCES. gate6 ran BEFORE the class counters existed. Its 10 requests /
  // 32,505,856 bytes is compatible with 7 chunk + 3 small, but it does not measure that decomposition, and
  // an aggregate cannot be made to yield one. Recording it as "7 + 3 measured" would manufacture evidence.
  const contract = read('src/core/projection/plex-dataplane.ts');
  assert(/EMPIRICAL WATCHDOG AND NOT A DERIVATION/.test(contract), 'it says what kind of number it is');
  assert(/INSTRUMENTED — EVERY WINDOW IS IN `PLEX_INSTRUMENTED_SCAN_WINDOWS`/.test(contract),
    'the provenance points at the dataset instead of spelling a count out');
  assert(/NOT INSTRUMENTED/.test(contract), 'and gate6 is filed separately from them');
  assert(/COMPATIBLE with 7 chunk \+ 3 small/.test(contract), 'gate6 is described as compatible, not measured');
  assert(/does not measure that decomposition/.test(contract), 'and explicitly not as a measurement');
  assert(/NEVER AN AUTOMATIC BUMP/.test(contract),
    'and that a breach is a finding to investigate rather than a number to raise');
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  assert(/EMPIRICAL WATCHDOG/.test(cli), 'and the gate report says so too, where an operator reads it');
  assert(/\$\{PLEX_GATE6_COMPATIBLE_BLOCKS\.BLOCKS\} is INFERRED/.test(cli),
    'the operator-visible note names the inferred figure from the constant, not as a literal');

  // THE ARITHMETIC THAT MAKES THE POINT UNARGUABLE: the decomposition is not unique.
  const CHUNK = PLEX_READ_GEOMETRY.CHUNK_BYTES;
  const WINDOW = PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES;
  assertEq(7 * CHUNK + 3 * WINDOW, 32_505_856, 'the gate6 total is consistent with 7 chunk + 3 small');
  // ...and equally with six demand blocks plus four responses of a size in neither class.
  const alternative = 6 * CHUNK + 4 * 1_835_008;
  assertEq(alternative, 32_505_856, 'and with 6 chunk + 4 mid-sized responses, which is a different mix');
  assertEq(6 + 4, 10, 'at the same request count, so the aggregate cannot distinguish them');

  // NO SOURCE MAY STATE THE CAUSAL CLAIM. Two loaded windows disagreed with each other; that is not a trend.
  // The ban is on the RELATIONSHIP being asserted, in any of the phrasings it has appeared in — one of which
  // survived two earlier sweeps inside a test comment, which is why this suite scans itself as well.
  for (const source of [...SCAN_MODEL_SOURCES, 'test/projection-plex-dataplane.ts']) {
    const text = withoutBanDeclarations(read(source));
    assert(!/tracks? (host )?contention|tracked (host )?contention|tracking (host )?contention/.test(text),
      `${source} does not assert the count tracks contention`);
    assert(!/nine windows|all nine|nine measured/.test(text),
      `${source} does not count gate6 among the instrumented windows`);
  }
});

await test('no source states the two backwards claims this amendment corrected', () => {
  // BOTH WERE WRITTEN BY ME, BOTH READ AS REASSURING, AND BOTH SAID THE OPPOSITE OF WHAT IS TRUE. Banning
  // the phrasings is worth more than fixing the instances: each survived a sweep by being reworded slightly.
  //
  // 1. THE BINDING ORDER. On the large fixture the ENVELOPE (0.348) is tighter than the 0.5 fraction, so the
  //    fraction cannot fail on its own. Naming the fraction as the operative bound, or demoting the envelope
  //    to a catch that only refuses the unseen, claims a strictness the fraction does not have there.
  // 2. THE CONTRADICTION CLAIM. Saying the envelope derives from the caps and therefore the two can never
  //    disagree is only
  //    true for an object that can serve a full demand block. A shorter one earns less from the same caps, and a
  //    scan can satisfy every class cap and still fail on bytes.
  for (const source of [...SCAN_MODEL_SOURCES, 'test/projection-plex-dataplane.ts']) {
    const text = withoutBanDeclarations(read(source));
    assert(!/fraction is the binding constraint/i.test(text),
      `${source} does not call the fraction the binding constraint`);
    assert(!/runaway catch/i.test(text),
      `${source} does not describe the envelope as a runaway catch beneath the fraction`);
    assert(!/so the two cannot contradict|cannot fail on bytes|cannot then fail on bytes/i.test(text),
      `${source} does not claim the caps subsume the byte ceiling`);
  }
  // AND THE POSITIVE STATEMENT IS PRESENT, so the ban cannot be satisfied by saying nothing at all.
  for (const source of SCAN_MODEL_SOURCES) {
    assert(/does not mathematically bind|is not what binds|not what would fail first|ENVELOPE is what binds|envelope\*\* is the binding constraint/
      .test(read(source)), `${source} says which of the two actually binds`);
  }
});

await test('the byte ceiling admits every measurement, including the one that broke the old ceiling', () => {
  // gate6 EXCEEDED the previous 24 MiB saturated ceiling — 32,505,856 against 25,165,824 — which is what
  // retired it. Every observation must fit the replacement, or it is not a replacement.
  const large = 105_406_871;
  const ceiling = plexScanByteCeiling([large]);
  for (const [measured, condition] of [
    [19_922_944, 'quiet, three runs'], [24_117_248, 'under CPU load'],
    [32_505_856, 'gate6 (an aggregate, not a class measurement)'],
  ] as Array<[number, string]>) {
    assert(measured <= ceiling, `${condition} (${measured}) fits the ceiling ${ceiling}`);
  }
  assert(32_505_856 > 25_165_824, 'and the old ceiling really was exceeded, which is why it is gone');
});

await test('an object ceiling is the class caps evaluated against ITS OWN length', () => {
  // THE FITTED 2x CLAMP IS GONE. It claimed the measurements supported it; gate8 measured 2.001951x and
  // refuted that. What replaced it is not another constant: it is the caps' own arithmetic per object,
  // `BLOCK x min(CHUNK, size) + SMALL x min(WINDOW, size)`.
  const CHUNK = PLEX_READ_GEOMETRY.CHUNK_BYTES;
  const WINDOW = PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES;
  const expected = (size: number): number =>
    PLEX_SCAN_ENVELOPE.BLOCK * Math.min(CHUNK, size) + PLEX_SCAN_ENVELOPE.SMALL * Math.min(WINDOW, size);

  assertEq(plexObjectByteCeiling(40_412), expected(40_412), 'a tiny entry: 11 reads of its own length');
  assertEq(plexObjectByteCeiling(40_412), 11 * 40_412, 'which is 444,532 bytes, not 35 MiB');
  assertEq(plexObjectByteCeiling(105_406_871), PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY,
    'and a large one gets the full envelope, because it can serve full blocks');
  assertEq(plexObjectByteCeiling(CHUNK), PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY,
    'exactly one demand block is already large enough to earn the whole envelope');
  assertEq(plexObjectByteCeiling(0), 0, 'and nothing costs nothing');

  // IT IS MONOTONIC IN SIZE, so a bigger object can never be held to a smaller allowance.
  let previous = 0;
  for (const size of [1, 1024, WINDOW, WINDOW + 1, CHUNK - 1, CHUNK, CHUNK * 10]) {
    const ceiling = plexObjectByteCeiling(size);
    assert(ceiling >= previous, `the ceiling does not decrease as size grows, at ${size}`);
    previous = ceiling;
  }
  // The aggregate is the sum of these, and nothing else.
  assertEq(plexScanByteCeiling([40_412, 40_412]), 2 * plexObjectByteCeiling(40_412), 'per object, summed');
});

await test('the gate8 corpus total is ADMITTED by the rule, and a genuine runaway is not', () => {
  // THE ARITHMETIC THE CORRECTION HAS TO SURVIVE. gate8's corpus window served 48,269,773 bytes across a
  // library of one 13,981,407-byte anchor, one 8,594,275-byte soak source and 38 corpus entries of about
  // 40,412 bytes. Under the retired 2x clamp the SUMMED ceiling was 48,222,708 and it failed by 47,065
  // bytes, with no way to say which object spent them.
  const anchor = 13_981_407;
  const soak = 8_594_275;
  const corpus = Array.from({ length: 38 }, () => 40_412);
  const gate8Bytes = 48_269_773;

  // ADMITTED. The two large objects alone are allowed more than the whole window cost, so no distribution
  // of gate8's bytes across this library breaches a per-object ceiling unless one object took an
  // implausible share — which is exactly what the per-object verdicts now check for.
  assert(plexObjectByteCeiling(anchor) + plexObjectByteCeiling(soak) > gate8Bytes,
    'the anchor and soak ceilings together exceed the entire gate8 corpus window');
  assert(plexScanByteCeiling([anchor, soak, ...corpus]) > gate8Bytes,
    'and so does the aggregate cross-check, so the window is admitted');

  // AND IT STILL HAS TEETH, per object, which is where they now live.
  assert(3 * anchor > plexObjectByteCeiling(anchor),
    'an anchor read three times over breaches its own ceiling');
  assert(50 * 40_412 > plexObjectByteCeiling(40_412),
    'a 40 KB entry read fifty times over breaches its own ceiling...');
  assert(50 * 40_412 < plexScanByteCeiling([anchor, soak, ...corpus]) / 10,
    '...while being far too small to trouble the aggregate, which is why per-object is what binds');

  // THE OLD RULE, FOR THE RECORD: it refused gate8 and could not say why.
  // The corpus entries are not all exactly 40,412 bytes — each is encoded from a different pattern — so
  // the recorded budget is used rather than recomputed from a rounded size.
  const retiredBudget = 48_222_708;
  assertEq(gate8Bytes - retiredBudget, 47_065, 'gate8 exceeded the retired clamp by the recorded figure');
  const recomputed = [anchor, soak, ...corpus].reduce(
    (total, size) => total + Math.min(PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY, 2 * size), 0);
  assert(Math.abs(recomputed - retiredBudget) < 1_000,
    'and recomputing it from nominal corpus sizes lands within a kilobyte of the recorded budget');
});

await test('an explicit --windows 0 forces every class AND the bytes to zero', () => {
  // The warm re-scan asserts that a second scan of an unchanged generation costs the provider nothing. That
  // is the whole assertion, so every class ceiling and the byte ceiling must be zero — and a floor beneath
  // a zero assertion would contradict it outright.
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  assert(/const zeroWindow = args\.flags\.get\('windows'\) === '0';/.test(cli),
    'it is the EXPLICIT flag, not a default, that does this');
  assert(/zeroWindow\s*\n?\s*\? \{ block: 0, small: 0, oversized: 0, bodyless: 0, total: 0 \}/.test(cli),
    'every request class is zeroed, the newly split ones included');
  assert(/zeroWindow \? 0 : Math\.ceil\(entries \* MEDIA_SERVER_BUDGETS\.MAX_SCAN_RESOLUTION_MULTIPLIER\)/
    .test(cli), 'and the resolutions');
  assert(/provider-bytes-floor-not-applicable/.test(cli), 'and no floor is applied beneath it');
  // THE BYTE ASSERTION IS OUTSIDE THE `sizes` GUARD, which is the whole point of the fix below it.
  const zeroBlock = cli.split('if (zeroWindow) {')[1]?.split('} else if (sizes.length > 0) {')[0] ?? '';
  assert(/exactly\(`\$\{gate\}-provider-bytes`, delta\('bytesServed'\), 0/.test(zeroBlock),
    'a zero window asserts bytes at exactly zero, with no object size involved');
  assert(GATE.includes('--gate PX14-rescan --entries 1 --windows 0'),
    'and the warm re-scan is the window that uses it');
});

await test('the 0.5 large-object fraction is untouched and remains the headline assertion', () => {
  assertEq(PLEX_LARGE_FIXTURE.MAX_SCAN_BYTE_FRACTION, MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION,
    'still the shared constant');
  assertEq(MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION, 0.5, 'still 0.5');
  // ON THE 105 MB FIXTURE THE ENVELOPE IS TIGHTER THAN THE FRACTION, so the ENVELOPE is what binds and the
  // fraction cannot fail on its own there. The fraction is kept as the explicit headline because it carries
  // the product's argument in the product's own terms, not because it is the operative bound.
  const large = 105_406_871;
  const envelopeFraction = plexScanByteCeiling([large]) / large;
  assert(envelopeFraction < PLEX_LARGE_FIXTURE.MAX_SCAN_BYTE_FRACTION,
    `the envelope is ${envelopeFraction.toFixed(3)} of the object, inside the 0.5 fraction`);
  assert(GATE.includes('--large-bytes "$LARGE_SIZE"'), 'and the fraction is still asserted on it');
});

await test('no per-open attribution has crept back in', () => {
  // The counters keep no association between a response and the open that caused it, so any constant of the
  // form "blocks per open" is an attribution the data cannot support. The envelope is expressed per ENTRY.
  const contract = read('src/core/projection/plex-dataplane.ts');
  const envelope = contract.split('export const PLEX_SCAN_ENVELOPE')[1]?.split('} as const);')[0] ?? '';
  assert(envelope.length > 0, 'the envelope exists');
  assert(!/OPENS_PER_NEW_ITEM|DEMAND_BLOCKS_PER_OPEN/.test(envelope),
    'and is defined without reference to any per-open factor');
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  const budget = cli.split("case 'budget':")[1]?.split("case 'traffic-window'")[0] ?? '';
  assert(!/OPENS_PER_NEW_ITEM/.test(budget), 'and the budget no longer multiplies by an assumed open count');
});

await test('the daemon-side geometry constants are still read off the daemon', () => {
  // These two are what the envelope is built out of, and they are not this gate's to choose.
  assertEq(PLEX_READ_GEOMETRY.CHUNK_BYTES, 4 * 1024 * 1024, 'the demand block is readpath.ChunkBytes');
  assertEq(PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES, 1_048_576, 'and the probe window is the manifest\'s');
  // ...and the envelope saturates for any object large enough, whatever its size. The diagnostic supports
  // SIZE INDEPENDENCE in the windows observed — two objects 2.35x apart measured identically in three quiet
  // runs — and load/timing sensitivity in the one window that moved. It does not support a demonstrated
  // relationship between the count and contention, and this comment used to assert one.
  assertEq(plexScanByteCeiling([512 * 1024 * 1024]), PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY,
    'a 512 MiB object gets the envelope');
  assertEq(plexScanByteCeiling([100 * 1024 * 1024]), PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY,
    'and so does a 100 MiB one');
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
  // Below saturation the ceiling still permits a whole-object read many times over — so satisfying it proves nothing
  // about the fraction. That is a limit of the INSTRUMENT, not a lower bound: it does not mean a below-one
  // read is unreachable at those sizes. The claim therefore moves to a fixture where an ACTUAL-BYTE
  // measurement has margin, held to the SHARED constant the Jellyfin gate is held to rather than a Plex one.
  assertEq(PLEX_LARGE_FIXTURE.MAX_SCAN_BYTE_FRACTION, MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION,
    'the same fraction, not a Plex-specific one');
  assertEq(MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION, 0.5, 'and the shared constant is untouched');
  // THE MINIMUM IS COMPUTED FROM THE ENVELOPE, so a cap change moves it. The meeting point of the two bounds
  // is envelope/fraction = 73,400,320; a fixture there would make them identical, so the minimum is above it.
  const meetingPoint = PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY / PLEX_LARGE_FIXTURE.MAX_SCAN_BYTE_FRACTION;
  assertEq(meetingPoint, 73_400_320, 'the envelope and the fraction meet at 73,400,320 bytes');
  assert(PLEX_LARGE_FIXTURE.MIN_BYTES > meetingPoint,
    'and the fixture minimum is strictly above it, so the two bounds are distinguishable');
  assertEq(PLEX_LARGE_FIXTURE.MIN_BYTES, 98_566_144, 'which is 94 MiB today');
  assertEq(PLEX_LARGE_FIXTURE.MIN_BYTES,
    plexLargeFixtureMinBytes(PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY,
      MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION),
    'and today\'s literal is what the function returns for today\'s inputs, not a parallel constant');
  assert(GATE.includes('--large-bytes "$LARGE_SIZE"'), 'the gate asserts the fraction on it');
  assert(GATE.includes(`test "$LARGE_SIZE" -ge ${PLEX_LARGE_FIXTURE.MIN_BYTES}`),
    'and refuses to run the claim against a fixture under the SAME computed minimum');
});

await test('the fixture minimum moves with BOTH its inputs, algebraically and not by coincidence', () => {
  // A LITERAL THAT HAPPENS TO MATCH TODAY IS NOT A DERIVATION. Matching 98,566,144 proves only that someone
  // did the arithmetic once. These cases prove the fixture is sized by the envelope and the SHARED fraction
  // as they stand at the time, so neither can move without moving it — the drift this whole amendment is
  // about. `LARGE_FIXTURE_MARGIN_OF_FRACTION` is 0.75, so the divisor is `fraction * 0.75`.
  const envelope = PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY;
  const fraction = MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION;
  const MiB = 1024 * 1024;

  // A TIGHTER SHARED CLAIM DEMANDS A BIGGER OBJECT: halving the permitted fraction doubles the minimum.
  assertEq(plexLargeFixtureMinBytes(envelope, fraction / 2),
    Math.ceil(envelope / (fraction / 2 * 0.75) / MiB) * MiB, 'halving the fraction is the doubled minimum');
  assert(plexLargeFixtureMinBytes(envelope, fraction / 2) > 2 * PLEX_LARGE_FIXTURE.MIN_BYTES - 2 * MiB,
    'and that really is about twice today\'s figure, not a rounding artefact');
  // A LOOSER ONE PERMITS A SMALLER OBJECT.
  assert(plexLargeFixtureMinBytes(envelope, 0.8) < PLEX_LARGE_FIXTURE.MIN_BYTES,
    'a more permissive fraction lowers the minimum');
  // AND A BIGGER ENVELOPE DEMANDS A BIGGER OBJECT, so raising the CHUNK cap cannot quietly leave the
  // fraction assertion sitting on a fixture too small to distinguish the two bounds.
  assert(plexLargeFixtureMinBytes(envelope * 2, fraction) >= 2 * PLEX_LARGE_FIXTURE.MIN_BYTES - MiB,
    'doubling the envelope roughly doubles the minimum');
  assert(plexLargeFixtureMinBytes(envelope / 2, fraction) < PLEX_LARGE_FIXTURE.MIN_BYTES,
    'and a smaller envelope lowers it');

  // THE INVARIANT THAT MAKES THE FIXTURE WORTH HAVING, at every combination: the envelope must come out
  // strictly under the fraction on an object of the minimum size, with the stated margin.
  for (const f of [0.2, 0.35, 0.5, 0.8]) {
    for (const e of [envelope / 4, envelope, envelope * 3]) {
      const min = plexLargeFixtureMinBytes(e, f);
      assert(e / min < f, `at fraction ${f} the envelope is under it on the minimum object`);
      assert(e / min <= f * 0.75 + 1e-9, 'and by the full three-quarters margin');
    }
  }
});

await test('the envelope binds tighter than the fraction on the large object, and says so', () => {
  // THE ORDERING MATTERS AND IS EASY TO REPORT BACKWARDS. On an object this size the byte ceiling is the
  // stricter of the two, so the 0.5 fraction cannot fail on its own: anything inside the ceiling is inside
  // the fraction. The fraction stays the headline because it is the product's claim in the product's terms,
  // but a report calling it the binding constraint here would overstate the gate.
  const large = 105_406_871;
  const envelopeFraction = plexScanByteCeiling([large]) / large;
  assert(envelopeFraction < PLEX_LARGE_FIXTURE.MAX_SCAN_BYTE_FRACTION,
    `the envelope is ${envelopeFraction.toFixed(3)} of the object, inside 0.5`);
  assertEq(Number(envelopeFraction.toFixed(3)), 0.348, 'measured at 0.348 on the fixture the gate builds');
  for (const source of ['src/core/projection/plex-dataplane.ts',
    'docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md', 'docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md']) {
    assert(/does not mathematically bind|is not what binds|not what would fail first/.test(read(source)),
      `${source} says which of the two actually binds`);
  }
});

await test('no source states a retired formula or a retracted absence in the present tense', () => {
  // THREE FALSE CLAIMS OUTLIVED THEIR CODE, AND EACH READ AS REASSURING. The scan model has been restated
  // five times now, and every sweep left a copy somewhere the previous ban was not looking. This one covers
  // the eight files the model touches and rejects a claim unless the same line marks it retired.
  const RETIRED = [
    { pattern: /min\(\s*36,?700,?160/, what: 'the retired min(36,700,160, 2 x size) ceiling' },
    { pattern: /2 x object size|2 × size|2 x its own size|twice its own length|twice the object/i,
      what: 'the retired 2x size clamp' },
    { pattern: /no per-reference attribution|does not add it|tranche does not add/i,
      what: 'the retracted claim that per-reference attribution does not exist' },
    // Scoped to the ENDPOINT. "the aggregate cannot attribute" is true and must stay sayable; "the
    // endpoint cannot attribute" is the retracted claim.
    { pattern: /endpoint (does not keep|cannot attribute|does not attribute)|telemetry cannot attribute/i,
      what: 'the retracted claim that the endpoint cannot attribute bytes' },
    // THREE PHRASINGS THE FIRST VERSION OF THIS SCAN MISSED, each a different way of saying the same
    // retracted thing. A ban that only knows the wording it was written against catches the instance and
    // not the class, which is how this model has now drifted six times.
    { pattern: /counts bytes for the whole window|cannot say which reference|which reference spent/i,
      what: 'the retracted claim that the endpoint measures only whole-window bytes' },
    { pattern: /both are aggregates|neither can attribute|both AGGREGATES/i,
      what: 'the retracted claim that the ceiling is an aggregate' },
    { pattern: /clamped by the object|clamp below the crossover|stricter one below/i,
      what: 'the retired separate clamp' },
    // SCOPED TO NaN. A bare "would pass" is ordinary English about anything at all — this same scan once
    // flagged a sentence about substring checks. The retracted claim is specifically that NaN passes, and
    // it does not: every helper compares with <=, >= or ===, and each is false against NaN, so NaN FAILS.
    { pattern: /NaN[^.]{0,80}(pass|silently)/i,
      what: 'the false claim that NaN makes a budget pass' },
  ];
  // CASE-INSENSITIVE, because these paragraphs shout their headings. A case-sensitive version of this list
  // rejected the very sentence that retracts the NaN claim, whose label reads "AN EARLIER VERSION ... WAS
  // WRONG" in capitals — a ban that fails on correct text teaches its reader to disable it.
  const LABELLED =
    /RETIRED|was refuted|no longer|earlier version|used to|had that backwards|retracted|was wrong|not because/i;

  for (const source of [...SCAN_MODEL_SOURCES, 'test/projection-plex-dataplane.ts',
    'projectiond/internal/fakeprovider/fakeprovider.go']) {
    const lines = withoutBanDeclarations(read(source)).split(String.fromCharCode(10));
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      for (const { pattern, what } of RETIRED) {
        if (!pattern.test(line)) continue;
        // A label may sit on the line itself or in the two lines above it, because these are prose
        // paragraphs and a heading commonly carries the label for the sentence beneath.
        const context = [lines[index - 2] ?? '', lines[index - 1] ?? '', line].join(' ');
        assert(LABELLED.test(context),
          `${source}:${index + 1} states ${what} in the present tense: ${line.trim().slice(0, 80)}`);
      }
    }
  }
});

await test('the retired 2x clamp is gone from the code, not merely unused', () => {
  // IT WAS REFUTED, SO IT IS REMOVED. Leaving the constant defined but unreferenced is how a retired rule
  // comes back: the next reader finds it, assumes it means something, and writes prose around it.
  for (const source of ['src/core/projection/plex-dataplane.ts',
    'src/ops/projection-plex-dataplane-cli.ts']) {
    assert(!/BYTE_SIZE_MULTIPLIER/.test(read(source)), `${source} no longer defines or reads the clamp`);
  }
  // AND THE CEILING IS THE CAPS' OWN ARITHMETIC, with nothing fitted in it.
  const contract = read('src/core/projection/plex-dataplane.ts');
  assert(/PLEX_SCAN_ENVELOPE\.BLOCK \* Math\.min\(PLEX_READ_GEOMETRY\.CHUNK_BYTES/.test(contract),
    'the per-object ceiling multiplies the BLOCK cap by the object-clamped demand block');
  assert(/PLEX_SCAN_ENVELOPE\.SMALL \* Math\.min\(PLEX_READ_GEOMETRY\.PROBE_WINDOW_BYTES/.test(contract),
    'and the SMALL cap by the object-clamped probe window');
  // The refutation is recorded rather than quietly dropped.
  assert(plexHighestCorpusScanRatio() > 2,
    'the highest recorded corpus ratio exceeds two, which is what refuted the clamp');
  // 2.00195198... — quoted as 2.001951x throughout, which is the truncation rather than the rounding.
  assert(Math.abs(plexHighestCorpusScanRatio() - 2.001951) < 1e-5, 'gate8 measured 2.001951x');
  assertEq(Number(plexHighestCorpusScanRatio().toFixed(3)), 2.002, 'which is 2.002 to three places');
  assert(!/cannot fail on bytes/.test(read('src/ops/projection-plex-dataplane-cli.ts')),
    'and the budget phase claims no equivalence between the caps and the byte ceiling');
});

await test('the envelope is computed from the caps, not from repeated literals', () => {
  // THE DEFECT THIS CLOSES: BYTES_PER_ENTRY was written as `8 * 4 MiB + 3 * 1 MiB`, so raising CHUNK to 9
  // would have left the byte half at the old value and the two halves would have disagreed in silence.
  const contract = read('src/core/projection/plex-dataplane.ts');
  const envelope = contract.split('export const PLEX_SCAN_ENVELOPE')[1]?.split('} as const);')[0] ?? '';
  assert(envelope.length > 0, 'the envelope exists');
  assert(/BYTES_PER_ENTRY: SCAN_CAP_BLOCK \* PLEX_READ_GEOMETRY\.CHUNK_BYTES/.test(envelope),
    'the byte figure is built from the same binding the BLOCK cap is');
  assert(/\+ SCAN_CAP_SMALL \* PLEX_READ_GEOMETRY\.PROBE_WINDOW_BYTES/.test(envelope),
    'and from the same binding the SMALL cap is');
  assert(/TOTAL: SCAN_CAP_BLOCK \+ SCAN_CAP_SMALL/.test(envelope), 'and the total is summed, not written');
  assert(!/BYTES_PER_ENTRY: \d/.test(envelope) && !/8 \* 4 \* 1024/.test(envelope),
    'and no literal cap is repeated inside it');
  // The arithmetic itself, so a "derived" expression that derives the wrong thing is still caught.
  assertEq(PLEX_SCAN_ENVELOPE.BYTES_PER_ENTRY, 36_700_160, '8 demand blocks + 3 probe windows');
  assertEq(PLEX_SCAN_ENVELOPE.TOTAL, 11, 'and eleven responses in total');
});

await test('the retired 24 MiB per-open scan model is not stated as current anywhere', () => {
  // Retired-model mentions are allowed ONLY as labelled history. Any occurrence must sit near the word that
  // marks it retired, and near the envelope that replaced it — otherwise a reader meets the old model as if
  // it were the contract, which is how this text drifted the first time.
  const sources = ['src/core/projection/plex-dataplane.ts', 'src/ops/projection-plex-dataplane-cli.ts',
    'deploy/projection-plex-dataplane-gate.sh', 'docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md',
    'docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md'];
  // `96 MiB` joins the list: it was four times the retired 24 MiB saturation point, so it is a survival of
  // the same model wearing a different number, and it outlived two sweeps that only looked for "24 MiB".
  const stale = /24 ?MiB|25,?165,?824|opens x min|opens × min|2 opens|96 ?MiB|96\+ ?MiB|100663296/;
  for (const source of sources) {
    const text = read(source);
    for (const line of text.split('\n')) {
      if (!stale.test(line)) continue;
      const at = text.indexOf(line);
      const window = text.slice(Math.max(0, at - 900), at + 900);
      assert(/retired|RETIRED|exceeded it|previous|used to be|An earlier/.test(window),
        `${source}: "${line.trim().slice(0, 70)}" is labelled as retired history`);
      assert(/envelope|36,700,160|BYTES_PER_ENTRY|class cap/.test(window),
        `${source}: and is paired with the model that replaced it`);
    }
  }
  // And the two flags whose pooled totals caused the wrong denominator are gone from the phase entirely.
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  const budget = cli.split("case 'budget':")[1]?.split("case 'traffic-window'")[0] ?? '';
  assert(budget.length > 0 && !/optionalNumber\(args, 'bytes'/.test(budget),
    'the budget phase no longer reads a pooled --bytes total');
  assert(!/--bytes |--small-bytes /.test(GATE.replace(/^#.*$/gm, '')),
    'and no gate call site still passes one');
});

await test('the re-scan budget is untouched, and it is the strongest claim Plex does support', () => {
  // A second scan of an unchanged generation must cost the provider ZERO ranged GETs and ZERO bytes. That is
  // the daemon's scan-window cache doing exactly what it exists for; it holds on Plex, and nothing above
  // relaxes it.
  assert(GATE.includes('--gate PX14-rescan --entries 1 --windows 0'),
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

await test('the byte floor sums per-object terms, and cannot be defaulted away', () => {
  // THE DEFECT THIS CLOSES. The floor was `min(totalRemote, count x 1 MiB)` and `totalRemote` came from
  // `--bytes`, which defaults to 1 — so the restart-scan call, which names sizes but no `--bytes`, had a
  // floor of ONE BYTE and could not fail.
  //
  // WHAT THIS TEST NO LONGER CLAIMS. It used to end with "a run that opened only the two large objects
  // cannot clear the floor for the other thirty-eight". That is false, and the arithmetic below shows why:
  // the floor is a SUM checked against ONE aggregate counter. See the cross-subsidy test that follows.
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  assert(/sizes\.reduce\(\s*\(total, size\) => total \+ Math\.min\(size, PLEX_READ_GEOMETRY\.PROBE_WINDOW_BYTES\)/
    .test(cli), 'the floor sums one probe window per object, or the object when it is shorter');
  assert(!/Math\.min\(totalRemote, sizes\.length/.test(cli), 'and the pooled-total form is gone');
  assert(!/const totalRemote/.test(cli), 'the pooled total is gone entirely');
  // The arithmetic, on a mixed library: 38 tiny objects plus two large ones.
  const window = PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES;
  const tiny = Array.from({ length: 38 }, () => 40_000);
  const mixedFloor = [...tiny, 8_594_275, 13_981_407]
    .reduce((total, size) => total + Math.min(size, window), 0);
  assertEq(mixedFloor, 38 * 40_000 + 2 * window,
    'each tiny object contributes its own length and each large one contributes one window');
  // NAMING SIZES IS WHAT FEEDS THE CEILING, AND THAT IS ALL IT DOES HERE. The restart-scan window supplies
  // `--object-sizes` so its ceiling is the per-object geometry rather than a default — but it is separately
  // marked `--warm-capable`, so it carries no floor at all. The next test is what proves that; this one
  // would contradict it if it still claimed the sizes bought a floor.
  assert(GATE.includes('--gate PX12b-restart-scan') && GATE.includes('--object-sizes "$CORPUS_SIZE_LIST"'),
    'the restart-scan call names object sizes, so its CEILING is the per-object geometry');
});

await test('a WARM-CAPABLE window keeps its ceilings and loses only its floors', () => {
  // THE DEFECT THIS CLOSES, AND IT WAS FOUND BY A REAL RUN. The scan after a media-server restart was given
  // the per-object byte floor, and gate6 measured that window at ZERO provider bytes — because the daemon's
  // persistent probe cache served everything Plex re-read, which is what the cache is for. The floor turned
  // the desired outcome into a failure and contradicted PX14, which asserts zero for the same situation. An
  // earlier run measured +37,924,876 bytes on the same window, so BOTH are valid and no floor fits.
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  assert(/args\.flags\.get\('warm-capable'\) === 'true'/.test(cli), 'the flag exists');
  assert(/-provider-bytes-warm-capable/.test(cli), 'and records the window under its own name');
  assert(GATE.includes('--gate PX12b-restart-scan') && GATE.includes('--warm-capable true'),
    'the restart scan is the window that uses it');
  // THE CEILINGS SURVIVE. A warm-capable window may cost nothing; it may not cost more than a cold scan.
  const budgetBlock = cli.split("case 'budget':")[1]?.split("case 'traffic-window'")[0] ?? '';
  const ceilingAt = budgetBlock.indexOf('-provider-bytes`');
  const warmAt = budgetBlock.indexOf("warm-capable') === 'true'");
  assert(ceilingAt > 0 && warmAt > ceilingAt,
    'the byte ceiling is recorded before the warm-capable branch, so the flag cannot skip it');
  assert(/-range-requests`/.test(budgetBlock), 'and the range-request ceiling is unconditional');
  // AND NO OTHER WINDOW GETS IT. A floor dropped where the provider really must be reached would be a
  // check that cannot fail.
  // Counted over EXECUTABLE lines only: the comment above the call names the flag too, and a check that
  // counted prose would fail the next time somebody explained the flag better.
  const invocations = GATE.split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .filter((line) => line.includes('--warm-capable true'));
  assertEq(invocations.length, 1, `exactly one window is warm-capable, found: ${invocations.join(' | ')}`);
  assert(GATE.includes('--gate PX9-scan') && !/--gate PX9-scan[^\n]*--warm-capable/.test(GATE),
    'the first cold scan keeps its floor');
  assert(!/--gate PX9c-large-object-scan[^\n]*--warm-capable/.test(GATE),
    'and so does the large-object scan, which is the one the fraction claim rests on');
});

await test('the request-shape diagnostic is wired in, and is asserted to account for every byte', () => {
  // A window that cost 32,505,856 bytes over 10 ranged requests cannot be turned into a budget: 7.75 demand
  // blocks is not a whole number of anything. The buckets let the next short diagnostic DERIVE the geometry
  // instead of picking a multiplier that clears the observation.
  const cli = read('src/ops/projection-plex-dataplane-cli.ts');
  for (const bucket of ['chunkResponses', 'chunkBytes', 'smallResponses', 'smallBytes',
    'partialResponses', 'partialBytes', 'oversizedResponses', 'oversizedBytes']) {
    assert(cli.includes(bucket), `the ${bucket} bucket is read from the counters`);
  }
  // AND THE BUCKET THEY REPLACED IS GONE, not merely unread. `other` conflated a clipped block with a body
  // larger than a demand block, so no budget could admit the harmless one without admitting the harmful one.
  assert(!/otherResponses|otherBytes/.test(cli),
    'the undifferentiated other bucket is gone from the phase entirely');
  assert(/-request-shape-accounts-for-every-byte/.test(cli),
    'and the BYTE partition is ASSERTED, so a response that escaped classification is visible');
  // THE REQUEST PARTITION IS A SEPARATE GATE, because bytes summing correctly says nothing about the count:
  // two responses filed as one leave the byte total intact and the count wrong, and the count is what a
  // geometry would be derived from.
  assert(/-request-shape-accounts-for-every-request/.test(cli), 'and so is the REQUEST partition');
  assert(cli.includes("shape('bodylessResponses')"),
    'reconciled with a single bodyless counter rather than a list of known faults');
  // THE ENUMERATION THIS REPLACES WAS SHORT BY A DOZEN PATHS. serveRange returns without a body for an
  // unknown object, a missing file, a malformed Range, 401, 403, 410, 503, a timeout and a redirect; adding
  // back only served429 and expiredRejected made the equation fail on any of them while the gate id claimed
  // to account for every request.
  assert(!/shape\('served429'\) \+ shape\('expiredRejected'\)/.test(cli),
    'the enumerated refusal list is gone');
  // It is recorded on every budgeted window, including the large-object one the claim rests on.
  assert(GATE.includes('--gate PX9c-large-object-scan'), 'the large-object window is budgeted');
  // AND IT CARRIES NOTHING IDENTIFYING. Counts and byte totals only; the Go side asserts the wire shape.
  const shapeNote = cli.split('gate: `${gate}-request-shape`')[1]?.split('});')[0] ?? '';
  assert(shapeNote.length > 0, 'the shape note exists');
  assert(!/offset|objectRef|url|lease/i.test(shapeNote),
    'and names no offset, reference, locator or lease — only counts and byte totals');
});

await test('transient decoder containers do not inherit a healthcheck they can never satisfy', () => {
  // THE DEFECT THIS CLOSES. The decoder image is a media server's image, borrowed for its ffmpeg; its
  // HEALTHCHECK probes that server on localhost:8096, which is not running because the entrypoint is
  // ffmpeg. A five-minute paced play that worked perfectly showed `unhealthy` in `docker ps` for its whole
  // duration. Nothing failed — and that is the problem: a status that is always wrong spends the signal,
  // and the next genuinely unhealthy container inherits an operator who has learned to ignore it.
  const driver = read('src/ops/projection-plex-dataplane.ts');
  assert(driver.includes("'--no-healthcheck'"), 'the paced consumer disables it');
  const runArgs = driver.split('const args = [')[1]?.split('];')[0] ?? '';
  assert(runArgs.includes('--no-healthcheck'), 'in the docker run argument list itself');
  assert(GATE.includes('DECODER_RUN_FLAGS=(--rm --no-healthcheck)'), 'and so does every gate decoder run');
  // EVERY decoder container in the gate goes through those flags — none is left calling docker run directly.
  const strays = (GATE.match(/docker run --rm[^\n]*\$DECODER_IMAGE/g) ?? []);
  assertEq(strays.length, 0, `no decoder run bypasses the shared flags, found: ${strays.join(' | ')}`);
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

// ---------------------------------------------------------------------------------------------------------
// THE WARM-CACHE CONTRACT ON A PLAYBACK WINDOW, RUN RATHER THAN READ.
//
// WHAT gate10 MEASURED. Five minutes of paced play, ten seeks and five minutes of transcode each reached the
// provider ZERO times, while independent decoders proved 300 s of playable output, ten distinct seek
// positions and 332 s of transcoded output. The cause is the repair: a handle release stopped deleting
// playback entries, so an object that fits in the cache is served from memory on every later open. The floor
// `atLeast(range requests, 1)` turned that into three failures.
//
// WHAT MUST NOT HAPPEN IN FIXING IT. Simply dropping the floor would accept ANY zero-provider window,
// including a stale mount or a bypassed daemon — the exact ambiguity the floor existed to catch. So the
// replacement demands POSITIVE evidence from the daemon's own cumulative counters, and these tests drive all
// three paths plus the two ways the evidence can be untrustworthy.
// ---------------------------------------------------------------------------------------------------------

/** Runs `traffic-window` with real provider and daemon snapshots, and returns the recorded verdicts. */
function runTrafficWindow(options: {
  provider: { before: Record<string, unknown>; after: Record<string, unknown> };
  daemon?: { before: unknown; after: unknown };
  argv?: readonly string[];
}): {
  status: number; reportStatus: number;
  results: Array<{ gate: string; verdict: string; measured?: number; note?: string }>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'plex-traffic-'));
  const write = (name: string, value: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const argv = ['traffic-window',
    '--before', write('p-before.json', options.provider.before),
    '--after', write('p-after.json', options.provider.after),
    '--gate', 'PXTEST-window', '--object-bytes', '8594275', '--results', join(dir, 'results.json'),
    ...(options.daemon === undefined ? [] : [
      '--daemon-before', write('d-before.json', options.daemon.before),
      '--daemon-after', write('d-after.json', options.daemon.after),
    ]),
    ...(options.argv ?? [])];
  const run = runCli(argv);
  const resultsPath = join(dir, 'results.json');
  const results = existsSync(resultsPath)
    ? readFileSync(resultsPath, 'utf8').split('\n').filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { gate: string; verdict: string; measured?: number; note?: string })
    : [];
  // A RECORDED FAILURE IS ONLY A FAILURE IF THE RUN ENDS ON IT. `traffic-window` records verdicts and exits
  // zero; `report` is what turns a recorded `fail` into a non-zero gate. Asserting the verdict alone would
  // let a fail verdict that the report ignored read as coverage.
  const reportStatus = results.length === 0 ? -1
    : runCli(['report', '--results', resultsPath]).status;
  return { status: run.status, reportStatus, results };
}

const COLD_PROVIDER = Object.freeze({ before: { rangeRequests: 10, bytesServed: 1_000_000 },
  after: { rangeRequests: 14, bytesServed: 5_000_000 } });
const WARM_PROVIDER = Object.freeze({ before: { rangeRequests: 59, bytesServed: 43_819_536 },
  after: { rangeRequests: 59, bytesServed: 43_819_536 } });
const verdictOf = (results: ReadonlyArray<{ gate: string; verdict: string }>, suffix: string):
string | undefined => results.find((r) => r.gate === `PXTEST-window${suffix}`)?.verdict;

await test('a COLD playback window keeps the original provider floor, unchanged and under its own name', () => {
  const run = runTrafficWindow({ provider: COLD_PROVIDER });
  assertEq(run.reportStatus, 0, 'a window that reached the provider passes the report');
  assertEq(verdictOf(run.results, '-range-requests-floor'), 'pass', 'the original floor still runs');
  // AND NOTHING WARM IS EMITTED. A cold run's verdict list must be byte-identical to what it was before this
  // correction, or two runs of the same gate cannot be compared.
  for (const suffix of ['-range-requests-warm-capable', '-warm-daemon-cache-hits',
    '-warm-daemon-cache-hit-bytes', '-warm-daemon-counters-coherent']) {
    assertEq(verdictOf(run.results, suffix), undefined, `a cold window emits no ${suffix}`);
  }
  // The ceilings are untouched by any of this.
  assertEq(verdictOf(run.results, '-provider-bytes'), 'pass', 'the byte ceiling still runs');
  assertEq(verdictOf(run.results, '-http-429'), 'pass', 'and the 429 ceiling');
  assertEq(verdictOf(run.results, '-full-body-on-range'), 'pass', 'and the full-body ceiling');
});

await test('a WARM window passes only on the daemon\'s own account of what it served', () => {
  const run = runTrafficWindow({
    provider: WARM_PROVIDER,
    daemon: {
      before: { playback: { hits: 12, hitBytes: 40_000, misses: 30, totalBytes: 8_594_275 } },
      after: { playback: { hits: 940, hitBytes: 25_000_000, misses: 30, totalBytes: 8_594_275 } },
    },
  });
  assertEq(run.reportStatus, 0, 'zero provider traffic with daemon cache evidence passes the report');
  assertEq(verdictOf(run.results, '-range-requests-warm-capable'), 'pass', 'the headline passes');
  assertEq(verdictOf(run.results, '-warm-daemon-cache-hits'), 'pass', '928 hits over the window');
  assertEq(verdictOf(run.results, '-warm-daemon-cache-hit-bytes'), 'pass', 'and 24,960,000 bytes');
  assertEq(verdictOf(run.results, '-warm-daemon-counters-coherent'), 'pass', 'the deltas are coherent');
  // THE OLD FLOOR IS NOT SILENTLY PASSED — it is not emitted at all, so nobody can read a pass into it.
  assertEq(verdictOf(run.results, '-range-requests-floor'), undefined, 'the provider floor does not apply');
  const hits = run.results.find((r) => r.gate === 'PXTEST-window-warm-daemon-cache-hits');
  assertEq(hits?.measured, 928, 'the delta is the measurement, not the absolute reading');
});

await test('a zero-provider window with NO daemon evidence FAILS: that is the bypass the floor caught', () => {
  const run = runTrafficWindow({ provider: WARM_PROVIDER });
  assertEq(run.reportStatus, 1, 'a generic zero-provider window fails the report');
  assertEq(verdictOf(run.results, '-range-requests-warm-capable'), 'fail', 'the headline fails');
  assertEq(verdictOf(run.results, '-warm-daemon-cache-hits'), 'fail', 'with no hits to show');
  const headline = run.results.find((r) => r.gate === 'PXTEST-window-range-requests-warm-capable');
  assert(/stale mount|bypassed daemon/.test(headline?.note ?? ''),
    'and the note names what a zero window with no evidence also looks like');
});

await test('a zero-provider window where the daemon served NOTHING fails, even with snapshots present', () => {
  const run = runTrafficWindow({
    provider: WARM_PROVIDER,
    daemon: {
      before: { playback: { hits: 5, hitBytes: 20_000, misses: 2, totalBytes: 0 } },
      after: { playback: { hits: 5, hitBytes: 20_000, misses: 2, totalBytes: 0 } },
    },
  });
  assertEq(run.reportStatus, 1, 'zero provider requests AND zero cache hits still fails the report');
  assertEq(verdictOf(run.results, '-warm-daemon-cache-hits'), 'fail', 'nothing was served from cache');
  assertEq(verdictOf(run.results, '-range-requests-warm-capable'), 'fail', 'so the window proves nothing');
});

await test('a daemon that RESTARTED inside the window cannot supply warm evidence for it', () => {
  // The gate SIGKILLs and restarts the daemon on purpose elsewhere in the same run, so this is the failure
  // mode a warm claim is most exposed to. Cumulative counters only rise within one process; a fall means the
  // two readings describe different processes and their difference is a number about nothing.
  const run = runTrafficWindow({
    provider: WARM_PROVIDER,
    daemon: {
      before: { playback: { hits: 900, hitBytes: 24_000_000, misses: 40, totalBytes: 8_594_275 } },
      after: { playback: { hits: 3, hitBytes: 9_000, misses: 1, totalBytes: 12_288 } },
    },
  });
  assertEq(run.reportStatus, 1, 'a counter that fell fails the report');
  assertEq(verdictOf(run.results, '-warm-daemon-counters-coherent'), 'fail', 'incoherence is named');
  assertEq(verdictOf(run.results, '-range-requests-warm-capable'), 'fail', 'and the headline fails with it');
  const coherence = run.results.find((r) => r.gate === 'PXTEST-window-warm-daemon-counters-coherent');
  assert(/RESTARTED/.test(coherence?.note ?? ''), 'and says a restart is what a falling counter means');
});

await test('a daemon too old to publish playback counters is named, not read as zero', () => {
  const run = runTrafficWindow({
    provider: WARM_PROVIDER,
    daemon: { before: { playbackCacheBytes: 8_594_275 }, after: { playbackCacheBytes: 8_594_275 } },
  });
  assertEq(run.reportStatus, 1, 'a missing counter block fails the report');
  assertEq(verdictOf(run.results, '-warm-daemon-counters-coherent'), 'fail', 'the absence is a failure');
  const coherence = run.results.find((r) => r.gate === 'PXTEST-window-warm-daemon-counters-coherent');
  assert(/no `playback` counters/.test(coherence?.note ?? ''), 'and it says which half is missing');
});

await test('a provider counter that FELL is a broken instrument, not a warm window', () => {
  // THE DEFECT THIS CLOSES. The branch was `> 0` and an else, so a NEGATIVE delta — the endpoint restarted
  // or its counters were reset between the two readings — landed in the WARM arm and was then decided
  // entirely by the daemon's cache evidence. That evidence can be perfectly healthy while the provider side
  // of the window describes nothing, so a reset endpoint would have been reported as "served from cache".
  const run = runTrafficWindow({
    provider: { before: { rangeRequests: 59, bytesServed: 43_819_536 },
      after: { rangeRequests: 4, bytesServed: 900_000 } },
    // Cache evidence that would otherwise carry a warm verdict, to prove the negative delta is what decides.
    daemon: {
      before: { playback: { hits: 12, hitBytes: 40_000, misses: 30, totalBytes: 8_594_275 } },
      after: { playback: { hits: 940, hitBytes: 25_000_000, misses: 30, totalBytes: 8_594_275 } },
    },
  });
  assertEq(run.reportStatus, 1, 'a window with no interval fails the report');
  assertEq(verdictOf(run.results, '-provider-counters-coherent'), 'fail', 'and says the counter fell');
  // THE WARM ARM IS REACHED ON EXACTLY ZERO AND NOTHING ELSE, so none of its records may be emitted here.
  for (const suffix of ['-range-requests-warm-capable', '-warm-daemon-cache-hits',
    '-warm-daemon-cache-hit-bytes', '-warm-daemon-counters-coherent']) {
    assertEq(verdictOf(run.results, suffix), undefined,
      `a negative delta must not reach the warm arm, but emitted ${suffix}`);
  }
  assertEq(verdictOf(run.results, '-range-requests-floor'), undefined, 'nor the cold floor');
});

await test('the daemon evidence interval is CONTAINED INSIDE the provider window, not overlapping it', () => {
  // Straggling work between the two closing snapshots must be able to make a window look COLDER and never
  // warmer. That requires the daemon snapshot to close FIRST at the end — and, at the start, to open LAST.
  // Reversed, a late read would add cache hits the provider delta never saw: an inflated warm claim built
  // out of activity the provider window excludes.
  const gate = read('deploy/projection-plex-dataplane-gate.sh');
  const at = (needle: string): number => {
    const index = gate.indexOf(needle);
    assert(index >= 0, `the gate contains ${needle}`);
    return index;
  };
  for (const window of ['seeks', 'play', 'soak']) {
    const providerBefore = at(`--out "$REL/out/counters-before-${window}.json"`);
    const daemonBefore = at(`daemon_counters "$WORK/out/daemon-before-${window}.json"`);
    const daemonAfter = at(`daemon_counters "$WORK/out/daemon-after-${window}.json"`);
    const providerAfter = at(`--out "$REL/out/counters-after-${window}.json"`);
    assert(providerBefore < daemonBefore,
      `${window}: the daemon's interval must OPEN after the provider's, so it starts inside it`);
    assert(daemonAfter < providerAfter,
      `${window}: the daemon's interval must CLOSE before the provider's, so it ends inside it`);
    assert(daemonBefore < daemonAfter, `${window}: and the daemon's own pair is in order`);
  }
});

await test('the gate hands the daemon window to all three playback traffic phases', () => {
  const gate = read('deploy/projection-plex-dataplane-gate.sh');
  // THE DEFECT THIS CLOSES IS THE ONE PX14 TAUGHT: an assertion that is correct and never reached. The CLI
  // can demand daemon evidence all it likes if the gate never passes any.
  for (const window of ['seeks', 'play', 'soak']) {
    assert(gate.includes(`daemon_counters "$WORK/out/daemon-before-${window}.json"`),
      `the ${window} window captures the daemon's counters before it`);
    assert(gate.includes(`daemon_counters "$WORK/out/daemon-after-${window}.json"`),
      `and after it`);
    assert(gate.includes(`--daemon-before "$REL/out/daemon-before-${window}.json"`),
      `and hands them to the ${window} assertion`);
  }
  // The status surface it reads is loopback-only and reached by joining the daemon's own namespace, not by
  // relaxing where the daemon listens.
  assert(gate.includes('"statusAddr": "127.0.0.1:9099"'), 'the daemon publishes on loopback only');
  assert(gate.includes('--network "container:$MOUNT_CONTAINER"'),
    'and the reader joins its network namespace rather than a published port');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`\n${name}\n  ${(error as Error).stack ?? error}`);
  process.exit(1);
}
