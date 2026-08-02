import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_SOAK, SEEK_PLAN_FRACTIONS, analyseSeekSet, findRedactionProblems,
  seekPlanProblems,
} from '../src/core/projection/media-server-dataplane.js';
import {
  EMBY_CONSUMER_CREDENTIAL_IS_FILE_BORNE, EMBY_CONSUMER_TOKEN_FILE, EMBY_CONTAINER_INIT_RUNS_AS_ROOT,
  EMBY_ENCODING_CONFIG_HAS_NO_TEMP_PATH, EMBY_FFMPEG, EMBY_FFPROBE, EMBY_ITEM_IDS_ARE_DATABASE_ROW_IDS,
  EMBY_PINNED_VERSION, EMBY_PLAYBACK_ENDPOINT_IS_ANONYMOUS, EMBY_PLAYLIST_DRIFT_CEILING_SECONDS,
  EMBY_PUBLIC_INFO_HAS_NO_WIZARD_FLAG, EMBY_SEGMENT_URLS_CARRY_NO_RUNTIME_TICKS, EMBY_SERVER_GID,
  EMBY_ITEMS_OMIT_LOCATION_TYPE, EMBY_PLACEHOLDER_SOURCE_TYPE, PACED_PLAY_DECODE_MARGIN_SECONDS,
  EMBY_SERVER_UID, EMBY_TRANSCODING_TEMP_PATH, embyAnonymousPlaybackIsRefused,
  embyConsumerExposureProblems, embyOrdinaryFileProblems, embyPlaylistProblems, embySegmentPositions,
  embyWizardPhase, isEmbyItemId, parseEmbyVariantPlaylist,
} from '../src/core/projection/emby-dataplane.js';
import {
  bootstrap, absolutePath, listMovies, pacedConsumerScript, pacedDirectPlay, repeatedQueryNames,
  wizardIsOpen, withoutLocators, type GateState,
} from '../src/ops/projection-emby-dataplane.js';

// Projection Phase 1 — the offline half of the EMBY data-plane gate.
//
// WHAT THIS SUITE IS FOR. The gate itself needs Docker, /dev/fuse, a real PostgreSQL and a real Emby, and it
// takes half an hour. This suite runs everywhere, in seconds, and holds the rules the gate depends on: that
// every wait is bounded, that a skipped run cannot look like a passing one, that the credential never reaches
// an argument vector, that the playlist arithmetic this server forces on the seek gate actually works, and
// that the report cannot leak.
//
// SEVERAL OF THESE ARE BEHAVIOURAL RATHER THAN STRUCTURAL, AND DELIBERATELY SO. The five Emby findings this
// gate rests on are all of the form "a comment in the Jellyfin driver describes a behaviour that is false
// here", and a regex over the source agrees with every one of those comments. So the bootstrap is driven
// against a real socket serving real Emby-shaped responses, INCLUDING the 200-then-401 wizard transition that
// replaces the flag Emby does not publish; the wrapper accounting is driven by running the wrapper with a
// stub gate; and the playlist parser is handed the exact bytes the pinned server was measured to emit.

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

console.log('Projection Phase 1 — Emby data plane (offline)');

// Read once, up here, because several sections below assert against the shipped scripts.
const GATE = read('deploy/projection-emby-dataplane-gate.sh');
const THREE = read('deploy/projection-emby-dataplane-gate-three.sh');
const OPTIONAL = read('deploy/projection-emby-dataplane-gate-optional.sh');

// ---------------------------------------------------------------------------------------------------------
// FINDING 4 — the variant playlist, and the server's own arithmetic
// ---------------------------------------------------------------------------------------------------------

// THE EXACT BYTES THE PINNED SERVER WAS MEASURED TO EMIT, trailing `, nodesc` included. That suffix is not
// decoration: an earlier reading of the duration stripped only the first comma, producing `3.0000 nodesc`,
// `Number(...)` of which is `NaN` — and a NaN cumulative position makes every seek assertion below it vacuous
// instead of failing.
const EMBY_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXTINF:3.0000, nodesc',
  'hls1/main/0.ts?PlaySessionId=probe-session-2',
  '#EXTINF:3.0000, nodesc',
  'hls1/main/1.ts?PlaySessionId=probe-session-2',
  '#EXTINF:3.0000, nodesc',
  'hls1/main/2.ts?PlaySessionId=probe-session-2',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

await test('the measured Emby playlist parses into segments and their declared durations', () => {
  const segments = parseEmbyVariantPlaylist(EMBY_PLAYLIST);
  assertEq(segments.length, 3, 'three segments');
  assertEq(segments[0]?.ref, 'hls1/main/0.ts?PlaySessionId=probe-session-2', 'the reference is verbatim');
  assertEq(segments[1]?.seconds, 3, 'the `, nodesc` suffix does not poison the duration');
  assert(segments.every((segment) => Number.isFinite(segment.seconds)),
    'no duration parsed as NaN, which would make every position downstream meaningless');
});

await test('positions are the cumulative sums the server itself states, which is finding 4', () => {
  const positions = embySegmentPositions(parseEmbyVariantPlaylist(EMBY_PLAYLIST));
  assertEq(positions.join(','), '0,3,6', 'segment N starts at the sum of the durations before it');
  // AND THE URLS REALLY DO CARRY NOTHING ELSE. If a future Emby started publishing `runtimeTicks`, this
  // driver would go on summing #EXTINF while a better number sat unused — which is why the gate asserts the
  // absence rather than assuming it.
  assert(EMBY_SEGMENT_URLS_CARRY_NO_RUNTIME_TICKS, 'the finding is recorded');
  const refs = parseEmbyVariantPlaylist(EMBY_PLAYLIST).map((segment) => segment.ref);
  assert(refs.every((ref) => !/runtimeTicks/i.test(ref)),
    'the measured playlist declares no per-segment position, so #EXTINF is the only source');
});

await test('a segment with no usable #EXTINF is kept at zero rather than dropped', () => {
  // DROPPING IT WOULD RENUMBER EVERY SEGMENT AFTER IT, so a seek to index N would fetch a different segment
  // than the one whose position was computed — and nothing downstream could see that it had.
  const segments = parseEmbyVariantPlaylist([
    '#EXTINF:3.0000, nodesc', 'a.ts',
    'b.ts',
    '#EXTINF:not-a-number', 'c.ts',
    '#EXTINF:3.0000, nodesc', 'd.ts',
  ].join('\n'));
  assertEq(segments.length, 4, 'every segment survives');
  assertEq(segments.map((segment) => segment.seconds).join(','), '3,0,0,3', 'the unusable ones read zero');
});

await test('a playlist the seek gate could not mean anything against is refused', () => {
  // EVERY PER-SEEK ASSERTION PASSES AGAINST THESE. Ten requests, ten 200s, ten decodable segments — while
  // `serverPositionSeconds` is identically zero for all ten and the position error measures nothing.
  assertEq(embyPlaylistProblems([{ ref: 'only.ts', seconds: 3 }], 340).length > 0, true,
    'a one-segment playlist leaves nowhere for a seek to land');
  const allZero = [{ ref: 'a.ts', seconds: 0 }, { ref: 'b.ts', seconds: 0 }];
  assert(embyPlaylistProblems(allZero, 340).some((problem) => problem.includes('no duration')),
    'a playlist stating no durations declares no position for any segment');
  const duplicated = [{ ref: 'a.ts', seconds: 3 }, { ref: 'a.ts', seconds: 3 }];
  assert(embyPlaylistProblems(duplicated, 6).some((problem) => problem.includes('same segment twice')),
    'two seeks to the same reference could not be distinguished');
  assert(embyPlaylistProblems([{ ref: 'a.ts', seconds: 3 }, { ref: 'b.ts', seconds: 3 }], 340)
    .some((problem) => problem.includes('different media')),
  'a playlist for the wrong item is caught rather than relocating every seek');
});

await test('the measured 342s-over-340s drift is inside the ceiling, and a wrong item is not', () => {
  // MEASURED: 114 x 3.0 s of #EXTINF against a 340 s source. Zero drift would fail a correct server, because
  // it rounds segment lengths up and pads the last one; a large ceiling would stop the check noticing a
  // playlist generated for a different item.
  const segments = Array.from({ length: 114 }, (_unused, index) => ({ ref: `${index}.ts`, seconds: 3 }));
  assertEq(embyPlaylistProblems(segments, 340).length, 0, 'the real measurement passes');
  assert(EMBY_PLAYLIST_DRIFT_CEILING_SECONDS >= 2, 'the ceiling admits the measured 2s of rounding');
  assert(embyPlaylistProblems(segments, 60).length > 0, 'a playlist describing quite different media fails');
});

await test('the ten-seek analysis works on positions derived from #EXTINF sums', () => {
  // THE END-TO-END SHAPE OF FINDING 4: the shared analysis is fed Emby-derived positions and the measured
  // constant offset, and has to reach the same verdicts it reaches on a server that publishes ticks.
  //
  // The offset of 10.0 s is the pinned server's own presentation-time base, measured over three out-of-order
  // probes: declared 3 / 318 / 66, decoded 13.0 / 328.0 / 76.0.
  const OFFSET = 10;
  const seeks = SEEK_PLAN_FRACTIONS.map((fraction, index) => {
    const requested = Math.round(fraction * 340 * 10) / 10;
    const serverPosition = Math.floor(requested / 3) * 3;
    return {
      index, requestedSeconds: requested, serverPositionSeconds: serverPosition,
      elapsedMs: 300, bytes: 44_000, sha256: `digest-${index}`,
    };
  });
  const decodes = seeks.map((seek) => ({
    index: seek.index, codec: 'h264', packets: 36, startSeconds: seek.serverPositionSeconds + OFFSET,
  }));
  const analysis = analyseSeekSet(seeks, decodes);
  assertEq(analysis.distinctSegments, 10, 'ten distinct segments');
  assertEq(analysis.decodedOffsetSpreadSeconds, 0, 'a constant offset is what proves the seeks landed');
  assert(analysis.backwardTransitions >= 3, 'the plan really goes backwards');
  assert(analysis.maxPositionErrorSeconds <= 4, 'the #EXTINF-derived position tracks what was asked for');
  assert(analysis.decodedSpanSeconds > 340 * 0.8, 'the decoded segments cover the media');

  // AND THE CHEAT IT MUST STILL REFUSE: the same segment returned ten times. Every per-seek assertion passes;
  // this is the one that does not.
  const sameSegment = seeks.map((seek) => ({ ...seek, serverPositionSeconds: 0, sha256: 'one-digest' }));
  const sameDecodes = sameSegment.map((seek) => ({
    index: seek.index, codec: 'h264', packets: 36, startSeconds: OFFSET,
  }));
  const cheat = analyseSeekSet(sameSegment, sameDecodes);
  assertEq(cheat.distinctSegments, 1, 'one segment ten times is one segment');
  assert(cheat.maxPositionErrorSeconds > 4, 'and the positions no longer track what was asked for');
});

await test('the seek plan itself is still the acceptance plan\'s, unchanged by this server', () => {
  assertEq(seekPlanProblems(SEEK_PLAN_FRACTIONS).length, 0, 'the shared plan is well formed');
  assertEq(SEEK_PLAN_FRACTIONS.length, 10, 'ten positions, which is what G9 says');
});

// ---------------------------------------------------------------------------------------------------------
// FINDING 1 — the wizard has no public flag, and the probe that replaces it
// ---------------------------------------------------------------------------------------------------------

await test('the wizard phase is read from an access-control transition, not from a flag', () => {
  assert(EMBY_PUBLIC_INFO_HAS_NO_WIZARD_FLAG, 'the finding is recorded');
  assertEq(embyWizardPhase(200), 'open', 'unauthenticated 200 before the wizard');
  assertEq(embyWizardPhase(401), 'complete', 'unauthenticated 401 after it');
  assertEq(embyWizardPhase(403), 'complete', 'a forbidden is a refusal too');
  // AN UNRECOGNISED STATUS IS NOT A GUESS IN EITHER DIRECTION. Reading it as complete would skip the
  // bootstrap and leave every later phase unauthenticated; reading it as open would re-run the wizard over a
  // live installation.
  assertEq(embyWizardPhase(503), 'unknown', 'a starting server is not a completed wizard');
  assertEq(embyWizardPhase(404), 'unknown', 'nor is a missing endpoint');
  assertEq(embyWizardPhase(0), 'unknown', 'nor is a transport failure');
});

/** A throwaway HTTP server that answers exactly what the pinned Emby was measured to answer. */
async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
}

await test('a bootstrap against a FRESH server runs the wizard and then logs in', async () => {
  const seen: string[] = [];
  let wizardComplete = false;
  await withServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] as string;
    seen.push(`${request.method} ${path}`);
    if (path === '/System/Info/Public') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ServerName: 'x', Version: EMBY_PINNED_VERSION, Id: 'abc' }));
      return;
    }
    if (path === '/Startup/Configuration' && request.method === 'GET') {
      // THE MEASURED TRANSITION: 200 while the wizard is open, 401 once it is complete.
      if (wizardComplete) { response.writeHead(401); response.end('Access token is invalid or expired.'); }
      else { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"UICulture":"en-us"}'); }
      return;
    }
    if (path === '/Startup/Complete') { wizardComplete = true; response.writeHead(204); response.end(); return; }
    if (path.startsWith('/Startup/')) {
      response.writeHead(request.method === 'GET' ? 200 : 204, { 'content-type': 'application/json' });
      response.end(request.method === 'GET' ? '{"Name":"MyEmbyUser"}' : '');
      return;
    }
    if (path === '/Users/AuthenticateByName') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ AccessToken: 'tok-1', User: { Id: 'user-1' } }));
      return;
    }
    response.writeHead(404); response.end();
  }, async (baseUrl) => {
    const state: GateState = { baseUrl };
    const ranWizard = await bootstrap(state, 'projection-gate', 'pw');
    assertEq(ranWizard, true, 'the wizard was open, so it ran');
    assertEq(state.token, 'tok-1', 'and a token came back');
    assertEq(state.userId, 'user-1', 'and a user id');
    assert(seen.includes('POST /Startup/Complete'), 'the wizard was completed through the server\'s own API');
    // ASKED FOR, NOT SKIPPED: the wizard expects this read before it will take the user.
    assert(seen.includes('GET /Startup/User'), 'the user endpoint is read before it is written');
  });
});

await test('a SECOND bootstrap against the same installation does NOT re-run the wizard', async () => {
  // THIS IS THE WHOLE REASON FINDING 1 MATTERS. The gate calls `bootstrap` twice — once to install, once
  // after restarting the media server — and the second call is supposed to prove the installation SURVIVED.
  // A Jellyfin-shaped check on `StartupWizardCompleted` reads `undefined !== true` against Emby, which is
  // ALWAYS true, so the second call would re-run the wizard and destroy the evidence it came to collect.
  const seen: string[] = [];
  await withServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] as string;
    seen.push(`${request.method} ${path}`);
    if (path === '/System/Info/Public') {
      response.writeHead(200, { 'content-type': 'application/json' });
      // NOTE WHAT IS ABSENT: no `StartupWizardCompleted`, exactly as measured.
      response.end(JSON.stringify({ ServerName: 'x', Version: EMBY_PINNED_VERSION, Id: 'abc' }));
      return;
    }
    if (path === '/Startup/Configuration' && request.method === 'GET') {
      response.writeHead(401); response.end('Access token is invalid or expired.'); return;
    }
    if (path === '/Users/AuthenticateByName') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ AccessToken: 'tok-2', User: { Id: 'user-1' } }));
      return;
    }
    response.writeHead(500); response.end('the wizard must not be touched on a completed installation');
  }, async (baseUrl) => {
    const state: GateState = { baseUrl };
    const ranWizard = await bootstrap(state, 'projection-gate', 'pw');
    assertEq(ranWizard, false, 'the wizard was already complete, so this was an ordinary login');
    assertEq(state.token, 'tok-2', 'and it still authenticated');
    assert(!seen.some((entry) => entry.startsWith('POST /Startup/')),
      'no part of the wizard was re-run over a live installation');
  });
});

await test('an unrecognised wizard status FAILS rather than being guessed in either direction', async () => {
  await withServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] as string;
    if (path === '/Startup/Configuration') { response.writeHead(503); response.end('starting'); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ Version: EMBY_PINNED_VERSION }));
  }, async (baseUrl) => {
    let message = '';
    try {
      await wizardIsOpen({ baseUrl });
    } catch (error) { message = (error as Error).message; }
    assert(message.includes('Refusing to guess'), `an unknown status is refused, got: ${message || '(no error)'}`);
  });
});

await test('a wizard that reports completion and stays open is a failure', async () => {
  // A `/Startup/Complete` that answered 204 without completing anything would leave the server permanently
  // open, and every later "authenticated" phase would be measuring an endpoint that answers to anybody.
  await withServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] as string;
    if (path === '/System/Info/Public') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ Version: EMBY_PINNED_VERSION })); return;
    }
    if (path === '/Startup/Configuration' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return;
    }
    if (path.startsWith('/Startup/')) {
      response.writeHead(request.method === 'GET' ? 200 : 204, { 'content-type': 'application/json' });
      response.end(request.method === 'GET' ? '{}' : ''); return;
    }
    response.writeHead(404); response.end();
  }, async (baseUrl) => {
    let message = '';
    try {
      await bootstrap({ baseUrl }, 'projection-gate', 'pw');
    } catch (error) { message = (error as Error).message; }
    assert(message.includes('still open to anonymous callers'),
      `a wizard that did not shut is caught, got: ${message || '(no error)'}`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// FINDING 2 — anonymous playback is refused, and what that costs the consumer
// ---------------------------------------------------------------------------------------------------------

await test('the anonymous-playback control treats a serve as a failure and a refusal as a pass', () => {
  assertEq(EMBY_PLAYBACK_ENDPOINT_IS_ANONYMOUS, false, 'the finding is recorded, opposite to Jellyfin\'s');
  assertEq(embyAnonymousPlaybackIsRefused(401), true, 'the measured answer passes');
  assertEq(embyAnonymousPlaybackIsRefused(403), true, 'and so does a forbidden');
  // A 200 HERE WOULD BE A REAL REGRESSION IN THE MEDIA SERVER, and this gate is in a position to notice it.
  assertEq(embyAnonymousPlaybackIsRefused(200), false, 'serving media to an unauthenticated caller fails');
  assertEq(embyAnonymousPlaybackIsRefused(206), false, 'so does serving a range of it');
  // ANYTHING THAT IS NEITHER MEANS THE CONTROL MEASURED NOTHING. A connection error and a refusal are
  // different facts, and a control that cannot tell them apart is not a control.
  assertEq(embyAnonymousPlaybackIsRefused(500), false, 'a server error is not evidence of authorization');
  assertEq(embyAnonymousPlaybackIsRefused(-1), false, 'nor is a transport failure');
});

await test('the paced consumer reads its credential from a file and never from an argument', () => {
  assert(EMBY_CONSUMER_CREDENTIAL_IS_FILE_BORNE, 'the arrangement is recorded');
  const script = pacedConsumerScript();
  assert(script.includes(`cat "/work/${EMBY_CONSUMER_TOKEN_FILE}"`),
    'the script reads the token from the file the driver wrote');
  assert(script.includes('X-Emby-Token'), 'and sends it as this server\'s own credential header');
  // NO LITERAL `\r\n` IN THE HEADER ARGUMENT. In POSIX sh a backslash inside DOUBLE quotes is literal, so
  // `"X-Emby-Token: $token\r\n"` sends four extra characters as part of the token VALUE and the server
  // answers 401. ffmpeg appends a real CRLF itself when the header lacks one.
  const headerLine = script.split('\n').find((line) => line.includes('-headers')) ?? '';
  assert(headerLine !== '', 'the header argument is findable');
  assert(!headerLine.includes('\\r') && !headerLine.includes('\\n'),
    'the header argument carries no backslash escape that sh would pass through as literal text');
  // THE POSITIONAL ARGUMENTS ARE THE FOUR NON-SECRET ONES. If a token ever became `$5`, the `docker run`
  // argv would carry it and `docker inspect` would keep it after the container was gone.
  assert(script.includes('ffmpeg="$1"; url="$2"; seconds="$3"; out="$4"'),
    'the script takes exactly four positional arguments, none of them the credential');
  assert(!/\$5/.test(script), 'nothing reads a fifth argument, which is where a credential would land');
  // `exec` so that `docker stop` on a wedged consumer reaches ffmpeg rather than a shell holding pid 1.
  assert(/^exec /m.test(script), 'the shell execs rather than staying as pid 1');
  // A RULE THIS REPOSITORY ENFORCES: every line's quotes close on it, because an unreadable line is one a
  // "does this region do X" check answers "no" for. `test/custody-runtime-closure.ts` holds shipped scripts
  // to this; the consumer script is generated rather than shipped, so it is held to it here.
  for (const line of script.split('\n')) {
    assertEq((line.match(/"/g) ?? []).length % 2, 0, `quotes close on this line: ${line}`);
  }
});

await test('the consumer\'s two spellings of one directory are kept apart', async () => {
  // A DEFECT THIS GATE ALREADY HIT, TWENTY MINUTES INTO A RUN. On an MSYS shell the absolute path Docker
  // Desktop understands is `/c/Users/...`, and a Windows `node` handed that opens `C:\c\Users\...` — which
  // does not exist. The driver bind-mounts the directory AND writes two files into it, so it needs both
  // spellings; the Jellyfin driver takes one and gets away with it because it has no credential to deliver.
  const driver = read('src/ops/projection-emby-dataplane.ts');
  assert(/localWorkDir, EMBY_CONSUMER_TOKEN_FILE/.test(driver),
    'the token is written through the LOCAL spelling');
  assert(/join\(opts\.localWorkDir, opts\.scriptRelPath\)/.test(driver),
    'and so is the consumer script');
  assert(/`\$\{opts\.workDir\}:\/work`/.test(driver),
    'while Docker still binds the shell\'s own spelling');
  assert(GATE.includes('--work-dir "$WORK" --local-work-dir "$REL"'),
    'and the gate passes WORK for Docker and REL for node, which is the distinction it documents elsewhere');

  // AND THE FILES ARE ACTUALLY WRITTEN WHERE THE OPTION SAYS. A structural check alone would pass against a
  // driver that named the field and then used the other one two lines later.
  const dir = mkdtempSync(join(tmpdir(), 'emby-consumer-'));
  const outcome = await pacedDirectPlay({
    image: 'unused', network: 'unused', containerName: 'emby-suite-nonexistent-consumer',
    workDir: '/some/docker/spelling', localWorkDir: dir,
    streamUrl: 'http://server:8096/Videos/6/stream', outputRelPath: 'out/x.mp4', seconds: 1,
    ffmpegPath: '/bin/ffmpeg', token: 'suite-token', scriptRelPath: 'out/paced-consumer.sh',
  });
  // The `docker run` is expected to fail here — there is no such image — and that is fine: what is under
  // test is where the files landed before it was launched.
  assert(outcome.exitCode !== 0, 'the stub launch did not succeed, which this test does not need it to');
  assert(existsSync(join(dir, EMBY_CONSUMER_TOKEN_FILE)), 'the token file landed in the local directory');
  assert(existsSync(join(dir, 'out', 'paced-consumer.sh')), 'and so did the script');
  assertEq(readFileSync(join(dir, EMBY_CONSUMER_TOKEN_FILE), 'utf8'), 'suite-token', 'with the token in it');
});

await test('the consumer is asked for more media than the gate asserts it decoded', () => {
  // A RUN OF THIS GATE FAILED AT 299 AGAINST 300, with startup 2.3 s, no stall and a healthy pacing ratio —
  // a completely correct five minutes of paced playback, failed by an off-by-one in the harness. `ffmpeg -t
  // N` stops at the last output frame at or before N, so the final progress record reports marginally under
  // N and `Math.floor` of it is N-1.
  assert(PACED_PLAY_DECODE_MARGIN_SECONDS > 0, 'there is a margin at all');
  const cli = read('src/ops/projection-emby-dataplane-cli.ts');
  assert(cli.includes('const consumerSeconds = seconds + PACED_PLAY_DECODE_MARGIN_SECONDS'),
    'the consumer is asked for the asserted floor plus the margin');
  assert(/seconds: consumerSeconds,/.test(cli), 'and that is what reaches the consumer');
  // THE ASSERTIONS THEMSELVES MUST STILL BE THE PLAN'S NUMBER. A margin applied to the assertion instead of
  // to the request would be exactly the weakening this is not.
  assert(/atLeast\(`EM18-paced-play-decoded-media-seconds:\$\{ref\}`,\s*\n?\s*Math\.floor\(analysis\.mediaSeconds\), seconds,/.test(cli),
    'the decoded-media floor is still `seconds`, the acceptance plan\'s 300, and not the padded request');
  assert(/atLeast\(`EM18-paced-play-wall-seconds:\$\{ref\}`, Math\.floor\(analysis\.wallSeconds\), seconds\)/.test(cli),
    'and so is the wall-clock floor');
  assertEq(MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS, 300, 'which is the shared five minutes, unchanged');
});

await test('the token file is readable by the container that has to read it', () => {
  // 0644 AND NOT 0600, DELIBERATELY. The consumer runs as uid 1000 and the gate does not — on an Unraid host
  // it runs as root. A 0600 file owned by the host user is unreadable by the container that must read it, so
  // the five-minute play would fail on exactly the platform this gate exists to eventually close on. Docker
  // Desktop hides this by ignoring modes on bind mounts, which is why it would have shipped.
  const driver = read('src/ops/projection-emby-dataplane.ts');
  assert(/chmodSync\(tokenPath, 0o644\)/.test(driver), 'the token file is group- and world-readable');
  assert(driver.includes('on an Unraid host it runs as'), 'and the reason is recorded where the mode is set');
  assert(driver.includes('WHAT THE LOOSER MODE COSTS'), 'along with what it costs');
  // AND THE COST IS IN THE DOCUMENT, not only in a source comment nobody reading the doc would see.
  assert(read('docs/PROJECTION_PHASE_1_EMBY_DATA_PLANE.md').includes('0644'),
    'the data-plane document states the mode and why');
});

await test('the exposure check searches for the exact token and refuses an empty search', () => {
  const token = 'live-token-abcdef';
  assertEq(embyConsumerExposureProblems('{"Args":["/work/out/paced-consumer.sh","/bin/ffmpeg"]}', token)
    .length, 0, 'a clean inspect has nothing to report');
  assert(embyConsumerExposureProblems(`{"Args":["-headers","X-Emby-Token: ${token}"]}`, token).length > 0,
    'a token in the argument vector is found');
  // A HEADER NAME ON THE COMMAND LINE IS CAUGHT EVEN WHEN THE VALUE INTERPOLATED TO NOTHING, because the
  // arrangement being wrong is the defect, not just this run's leak.
  assert(embyConsumerExposureProblems('{"Args":["-headers","X-Emby-Token: "]}', token).length > 0,
    'an inline credential header is caught even with an empty value');
  // AND A SEARCH FOR NOTHING IS NOT A PASS. This is the check that would otherwise succeed forever once the
  // thing it reads goes away.
  assert(embyConsumerExposureProblems('{"Args":[]}', '').length > 0,
    'an empty token means the check searched for nothing and must say so');
});

// ---------------------------------------------------------------------------------------------------------
// FINDING 3 — nothing to configure, so the encoder is observed by binding
// ---------------------------------------------------------------------------------------------------------

await test('the gate binds the transcoding directory instead of configuring one', () => {
  assert(EMBY_ENCODING_CONFIG_HAS_NO_TEMP_PATH, 'the finding is recorded');
  assertEq(EMBY_TRANSCODING_TEMP_PATH, '/config/transcoding-temp', 'the measured path');
  // THE JELLYFIN PHASE MUST NOT HAVE BEEN COPIED. POSTing a document with fields this server ignores would be
  // a phase reporting success for doing nothing.
  assert(!GATE.includes('drive configure-encoding'),
    'the gate does not RUN a configure-encoding phase, because there is nothing here to configure');
  assert(!read('src/ops/projection-emby-dataplane.ts').includes('TranscodingTempPath'),
    'and the driver does not set a field this server does not have');
  assert(GATE.includes('drive encoder-observability'),
    'it asserts the bind exists instead, so a zero-file soak means the encoder wrote nothing');
  assert(GATE.includes('EMBY_TRANSCODE_SUBDIR="transcoding-temp"'), 'from the measured subdirectory');
});

// ---------------------------------------------------------------------------------------------------------
// FINDING 5 — the container init is root, so the write-refusal test names its uid
// ---------------------------------------------------------------------------------------------------------

await test('the mutation test runs as BOTH the server uid and root, and asserts which it is', () => {
  assert(EMBY_CONTAINER_INIT_RUNS_AS_ROOT, 'the finding is recorded');
  // A bare `docker exec` on this image lands as root. Copying Jellyfin's inline `id -u != 0` would fail —
  // which is fine — but the dangerous repair is deleting that assertion, at which point the mutation attempts
  // run as root and the gate has quietly stopped testing the thing it names.
  assert(GATE.includes('docker exec -i -u 1000:1000 "$EMBY_CONTAINER" sh -s 1000'),
    'the mutations are attempted as the uid the server actually runs as');
  assert(GATE.includes('docker exec -i "$EMBY_CONTAINER" sh -s 0'),
    'and again as root, which is the stronger claim that the DAEMON is what refuses');
  assert(GATE.includes('test "$(id -u)" = "$expected_uid"'),
    'and the script asserts which identity it is actually running as, rather than assuming');
  // THE READS THAT PRECEDE A SCAN ARE ALSO THE SERVER'S OWN UID. Root being able to read the mount says
  // nothing about whether the server can, and the server is the thing that has to.
  assert(GATE.includes('docker exec -u 1000:1000 "$EMBY_CONTAINER" test -r'),
    'the pre-scan readability check uses the server\'s uid');
  assert(GATE.includes('docker exec -u 1000:1000 "$EMBY_CONTAINER" \\\n  sh -c "head -c 65536'),
    'and so does the post-remount byte read, which is what stops a churn assertion passing on a dead mount');
});

await test('the container is started the way this image drops privilege, not the way Jellyfin\'s is', () => {
  // `--user 1000:1000` would run the s6 supervisor as an unprivileged user that cannot do the setuid it
  // exists to do. Measured: with the flags below, `ps` shows `root s6-svscan` and `1000 EmbyServer`.
  assert(GATE.includes('-e UID=1000 -e GID=1000'), 'the uid comes from the image\'s own environment');
  assert(!/start_emby\(\)[\s\S]{0,600}--user /.test(GATE),
    'and NOT from --user, which this image cannot start under');
  // THE CAPABILITY SET IS THE NARROWEST THE IMAGE ACTUALLY STARTS UNDER, measured rather than copied.
  for (const capability of ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER']) {
    assert(GATE.includes(`--cap-add ${capability}`), `the measured minimum includes ${capability}`);
  }
  assert(GATE.includes('--cap-drop ALL'), 'everything else is dropped');
  assert(GATE.includes('--security-opt no-new-privileges'), 'and no new privileges are available');
  assertEq(EMBY_SERVER_UID, 1000, 'the recorded uid');
  assertEq(EMBY_SERVER_GID, 1000, 'the recorded gid');
});

// ---------------------------------------------------------------------------------------------------------
// What an ordinary file is, and what an Emby id is
// ---------------------------------------------------------------------------------------------------------

// THE SHAPE MEASURED ON THE PINNED SERVER. Note what is ABSENT: no `LocationType`, because this server does
// not send one even when it is explicitly requested in `fields` — see `EMBY_ITEMS_OMIT_LOCATION_TYPE`.
const ORDINARY = Object.freeze({
  key: 'Projection Local One (2026).mp4',
  protocol: 'File',
  container: 'mp4',
  isRemote: false,
  supportsDirectPlay: true,
  mediaSourceType: 'Default',
  path: '/media/projection/Movies/Projection Local One (2026)/Projection Local One (2026).mp4',
  mediaSourcePath: '/media/projection/Movies/Projection Local One (2026)/Projection Local One (2026).mp4',
});

await test('the ordinary-file predicate names WHICH property failed, not merely that one did', () => {
  assertEq(embyOrdinaryFileProblems(ORDINARY).length, 0, 'the measured shape is an ordinary file');
  // THREE COMPLETELY DIFFERENT FAILURES OF THIS PRODUCT, which must not arrive as the same word.
  assert(embyOrdinaryFileProblems({ ...ORDINARY, protocol: 'Http' })[0]?.includes('not reading a local file'),
    'a server that decided to fetch the media itself');
  assert(embyOrdinaryFileProblems({ ...ORDINARY, mediaSourceType: 'Placeholder' })[0]?.includes('placeholder'),
    'an item it catalogued but never opened, which is what LocationType=Virtual meant on Jellyfin');
  assert(embyOrdinaryFileProblems({ ...ORDINARY, mediaSourceType: '' })[0]?.includes('states no kind'),
    'and a source stating no kind rules nothing out, so it is not treated as fine');
  assert(embyOrdinaryFileProblems({ ...ORDINARY, mediaSourcePath: '/somewhere/else.mp4' })[0]
    ?.includes('different file'),
  'a source pointing somewhere other than the projected path, which the Jellyfin predicate never checked');
  assert(embyOrdinaryFileProblems({ ...ORDINARY, container: '' })[0]?.includes('did not probe'),
    'a file it never successfully probed');
  assert(embyOrdinaryFileProblems({ ...ORDINARY, isRemote: true }).length > 0, 'a remote media source');
  assert(embyOrdinaryFileProblems({ ...ORDINARY, supportsDirectPlay: false }).length > 0, 'a non-direct-play source');
  assert(embyOrdinaryFileProblems({ ...ORDINARY, key: 'x.strm' })[0]?.includes('.strm'),
    'and a .strm pointer, which is the shape this appliance exists NOT to be');
});

await test('FINDING 6: LocationType is absent, and what replaces it is not weaker', () => {
  // MEASURED TWICE, WITH THE FIELD EXPLICITLY REQUESTED: `fields=Path,MediaSources` and
  // `fields=Path,MediaSources,LocationType` return the IDENTICAL key set on the pinned server, and
  // `LocationType` is in neither. This was found by a FAILING RUN: the first complete attempt at this gate
  // catalogued both published entries and matched ZERO of them, because an inherited predicate required a
  // field this server does not send.
  assert(EMBY_ITEMS_OMIT_LOCATION_TYPE, 'the finding is recorded');
  assertEq(EMBY_PLACEHOLDER_SOURCE_TYPE, 'Placeholder', 'the value that means "catalogued but never opened"');
  // THE DRIVER MUST NOT ASK FOR IT AND MUST NOT DEPEND ON IT.
  const driver = read('src/ops/projection-emby-dataplane.ts');
  assert(!/locationType:/.test(driver), 'the item record carries no locationType');
  assert(!/fields: '[^']*LocationType/.test(driver), 'and the listing does not request a field it never gets');
  // AND THE REPLACEMENT REFUSES BOTH THINGS THE ORIGINAL REFUSED, plus one it did not.
  assert(embyOrdinaryFileProblems({ ...ORDINARY, mediaSourceType: 'Placeholder' }).length > 0,
    'a placeholder source is refused, which is what LocationType=Virtual refused');
  assert(embyOrdinaryFileProblems({ ...ORDINARY, isRemote: true }).length > 0,
    'and a remote source, which is what LocationType=Remote refused');
  assert(embyOrdinaryFileProblems({ ...ORDINARY, mediaSourcePath: '/elsewhere.mp4' }).length > 0,
    'and a source pointing away from the projected path, which the original never checked at all');
});

await test('an Emby item id is a database row id, and the gate does not read more into it', () => {
  assert(EMBY_ITEM_IDS_ARE_DATABASE_ROW_IDS, 'the finding is recorded');
  assertEq(isEmbyItemId('6'), true, 'the measured shape');
  assertEq(isEmbyItemId('3'), true, 'and the library\'s');
  assertEq(isEmbyItemId('a1b2c3d4e5f60718293a4b5c6d7e8f90'), false, 'a Jellyfin GUID is not one');
  assertEq(isEmbyItemId(''), false, 'and neither is nothing');
  // ON EMBY A STABLE ID PROVES THE ROW SURVIVED AND DOES NOT INDEPENDENTLY CORROBORATE THE PATH, the way a
  // path-derived GUID does. So the churn comparison carries a path assertion of its own.
  assert(read('src/ops/projection-emby-dataplane-cli.ts').includes('-path-drift'),
    'the churn gate asserts the projected path separately, because the id cannot carry that half here');
});

await test('the item listing takes the media-source id the server actually mints', async () => {
  // MEASURED: Emby's media-source id is `mediasource_<itemId>`, not the item id. Using the item id produces a
  // request the server answers differently, so this is a correctness question rather than cosmetics.
  await withServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] as string;
    if (path === '/Items') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        // THE MEASURED SHAPE, INCLUDING WHAT IS ABSENT. There is no `LocationType` here because the pinned
        // server sends none — see the finding-6 test below.
        Items: [{
          Id: '6', Name: 'Probe One', Path: '/media/projection/Movies/Probe One (2026)/Probe One (2026).mp4',
          MediaSources: [{
            Id: 'mediasource_6', Type: 'Default', Size: 8_594_315, Container: 'mp4', Protocol: 'File',
            Path: '/media/projection/Movies/Probe One (2026)/Probe One (2026).mp4',
            IsRemote: false, SupportsDirectPlay: true, RunTimeTicks: 3_400_000_000,
            MediaStreams: [{ Type: 'Video', Codec: 'mpeg4' }, { Type: 'Audio', Codec: 'aac' }],
          }],
        }],
      }));
      return;
    }
    response.writeHead(404); response.end();
  }, async (baseUrl) => {
    const items = await listMovies({ baseUrl, token: 't', userId: 'u', libraryId: '3' });
    assertEq(items.length, 1, 'one item');
    assertEq(items[0]?.mediaSourceId, 'mediasource_6', 'the media-source id, not the item id');
    assertEq(items[0]?.itemId, '6', 'and the item id beside it');
    assertEq(items[0]?.key, 'Probe One (2026).mp4', 'keyed by basename');
    assertEq(items[0]?.videoCodec, 'mpeg4', 'the source codec the transcode assertion needs');
    assertEq(items[0]?.runTimeSeconds, 340, 'the duration the playlist check is made against');
    assertEq(items[0]?.mediaSourceType, 'Default', 'the media-source kind, which replaces LocationType here');
    assertEq(items[0]?.mediaSourcePath, items[0]?.path, 'the source points at the projected path itself');
    assertEq(embyOrdinaryFileProblems(items[0]!).length, 0, 'and it is an ordinary file');
  });
});

// ---------------------------------------------------------------------------------------------------------
// Bounded waits, redaction, and URL handling
// ---------------------------------------------------------------------------------------------------------

await test('every deadline the driver uses is finite and positive', () => {
  // A HANG IS A FAILURE. A gate whose waits are unbounded does not fail when the thing it waits for never
  // happens — it occupies the machine, and "still going" is indistinguishable from "stuck".
  for (const [name, value] of Object.entries(MEDIA_SERVER_DEADLINES_MS)) {
    assert(Number.isFinite(value) && value > 0, `${name} is a finite positive budget`);
  }
  const driver = read('src/ops/projection-emby-dataplane.ts');
  assert(!/while\s*\(\s*true\s*\)/.test(driver), 'the driver has no unbounded while(true)');
  // The one `for (;;)` is inside `until`, which is the shared bounded-poll shape and takes a Deadline.
  assertEq((driver.match(/for \(;;\)/g) ?? []).length, 2,
    'the only unconditional loops are the bounded poll and the incremental body reader');
  assert(driver.includes('AbortController'), 'requests carry an explicit, ref\'d watchdog');
  // THE BAN IS ON USING IT, NOT ON NAMING IT. The driver's comment explains at length why
  // `AbortSignal.timeout` is wrong here — its timer is unref'd, so a fetch against a socket that accepted the
  // connection and never answered leaves nothing holding the event loop open and Node exits with status 0.
  // A ban that tripped on that explanation would be a ban that deleted its own reasoning.
  assert(!/signal:\s*AbortSignal\.timeout/.test(driver),
    'no request is armed with AbortSignal.timeout, whose unref\'d timer lets a hung fetch exit with status 0');
});

await test('a realistic report is redaction-safe, and a leaky one is caught', () => {
  const results = [
    // THE VERSION IS HYPHENATED, AND THIS ROW IS A REGRESSION TEST FOR A REAL DEFECT THIS SUITE FOUND.
    // `4.9.5.0` matches the four-dotted-groups pattern that enforces "no IP address in a report" exactly, so
    // the obvious note `server version 4.9.5.0` made the whole report be refused — at the END of a half-hour
    // run, after every assertion had already passed. See `redactionSafeVersion`.
    { gate: 'EM1-bootstrap', verdict: 'pass', note: 'server version 4-9-5-0' },
    { gate: 'EM3-scan1-corpus-matched', verdict: 'pass', measured: 50, budget: 50 },
    { gate: 'EM4b-anonymous-direct-play-refused:0a1b2c3d4e5f', verdict: 'pass', measured: 401, budget: 401 },
    { gate: 'EM19-seek-decoded-offset-spread-x10:0a1b2c3d4e5f', verdict: 'pass', measured: 0, budget: 15 },
  ];
  assertEq(findRedactionProblems(results).length, 0, 'the shapes this gate actually emits are clean');
  // AND THE THINGS §7 FORBIDS ARE CAUGHT, including this server family's own credential spelling.
  assert(findRedactionProblems([{ gate: 'x', note: 'http://fakerange:8099/direct/obj' }]).length > 0, 'a URL');
  assert(findRedactionProblems([{ gate: 'x', note: 'api_key=abc' }]).length > 0, 'an api key');
  assert(findRedactionProblems([{ gate: 'x', note: '/media/projection/Movies' }]).length > 0, 'a path');
  assert(findRedactionProblems([{ gate: 'x', note: '172.17.0.2' }]).length > 0, 'an address');
  assert(findRedactionProblems([{ gate: 'x', note: 'Token="abc"' }]).length > 0, 'a token');
});

await test('the WAN address this server volunteers is never read into a report', () => {
  // MEASURED: once the pinned Emby has worked out its own addresses, `/System/Info/Public` carries
  // `LocalAddress` and `WanAddress` — the second of which is the HOST'S PUBLIC IP, discovered by the server on
  // its own initiative. The driver reads exactly one field out of that body.
  const driver = read('src/ops/projection-emby-dataplane.ts');
  assert(driver.includes('return info.Version ?? \'unknown\';'),
    'the version is the only field taken from the public info body');
  assert(!driver.includes('WanAddress') || driver.includes('host\'s PUBLIC IP'),
    'and if the field is named at all it is named as a hazard rather than read');
});

await test('a diagnostic is scrubbed of locators before it can reach an output', () => {
  const noisy = 'Error opening input http://projection-em-server-1:8096/Videos/6/stream at 172.17.0.2:8096';
  const clean = withoutLocators(noisy);
  assert(!clean.includes('http://'), 'the URL is gone');
  assert(!clean.includes('172.17.0.2'), 'and the address');
  assert(clean.includes('Error opening input'), 'and the diagnosable part survives');
});

await test('playlist-relative references resolve against the document that named them', () => {
  assertEq(absolutePath('/Videos/6/master.m3u8?a=1', 'main.m3u8?b=2'), '/Videos/6/main.m3u8?b=2',
    'a sibling reference');
  assertEq(absolutePath('/Videos/6/main.m3u8?b=2', 'hls1/main/0.ts?PlaySessionId=x'),
    '/Videos/6/hls1/main/0.ts?PlaySessionId=x', 'the measured segment shape');
  assertEq(absolutePath('/Videos/6/main.m3u8', '/absolute.ts'), '/absolute.ts', 'an absolute reference');
  // AN ABSOLUTE URL BACK TO THE SAME SERVER KEEPS ONLY ITS PATH: the gate's base URL is the authority, and
  // following a host the server named would be a redirect this gate does not take.
  assertEq(absolutePath('/Videos/6/main.m3u8', 'http://elsewhere:8096/x.ts?q=1'), '/x.ts?q=1',
    'a server-named host is not followed');
});

await test('a query with a repeated parameter name is diagnosable without printing the URL', () => {
  assertEq(repeatedQueryNames('/a?x=1&y=2').length, 0, 'nothing repeated');
  assertEq(repeatedQueryNames('/a?x=1&X=2&y=3').join(','), 'x', 'case-insensitively, names only');
  assertEq(repeatedQueryNames('/a').length, 0, 'and no query at all is not a repeat');
});

// ---------------------------------------------------------------------------------------------------------
// The gate's own accounting: a skip is not a pass
// ---------------------------------------------------------------------------------------------------------

/** Run a wrapper against a stub gate that exits with a scripted status, and report what happened. */
function runWrapper(script: string, gateExit: number, runs?: string): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'emby-gate-wrapper-'));
  const stub = join(dir, 'stub-gate.sh');
  writeFileSync(stub, `#!/usr/bin/env bash\necho "stub gate ran"\nexit ${gateExit}\n`);
  chmodSync(stub, 0o755);
  const result = spawnSync('bash', [join(repoRoot, 'deploy', script)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECTION_EMBY_GATE_COMMAND: stub,
      ...(runs === undefined ? {} : { PROJECTION_EMBY_GATE_RUNS: runs }),
    },
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

await test('the three-run wrapper propagates a SKIP rather than folding it into success', () => {
  // THIS IS THE FAILURE MODE THAT MATTERS MOST. A green tranche-closing command that proved nothing is the
  // single worst thing this repository can produce, and it is one status code away.
  const skipped = runWrapper('projection-emby-dataplane-gate-three.sh', 77);
  assertEq(skipped.status, 77, 'a skip exits 77, not 0');
  assert(skipped.output.includes('CLOSES NOTHING'), 'and says so');
  assert(!skipped.output.includes('consecutive EMBY runs completed'),
    'and does not announce a completed sequence');
});

await test('the three-run wrapper stops at the first failure rather than averaging', () => {
  const failedRun = runWrapper('projection-emby-dataplane-gate-three.sh', 1);
  assertEq(failedRun.status, 1, 'the failure propagates');
  assertEq((failedRun.output.match(/stub gate ran/g) ?? []).length, 1,
    'the sequence stopped after the first failure: two of three passing is not what the plan asks for');
});

await test('three green runs are counted, and zero requested runs cannot announce a sequence', () => {
  const green = runWrapper('projection-emby-dataplane-gate-three.sh', 0);
  assertEq(green.status, 0, 'three green runs succeed');
  assertEq((green.output.match(/stub gate ran/g) ?? []).length, 3, 'and there really were three');
  assert(green.output.includes('3 of 3 consecutive EMBY runs completed'), 'the count is stated');
  // A LOOP THAT NEVER RAN MUST NOT BE ABLE TO ANNOUNCE A COMPLETED SEQUENCE EITHER. The closing message is
  // guarded by the count rather than by having fallen out of the loop.
  const none = runWrapper('projection-emby-dataplane-gate-three.sh', 0, '0');
  assert(none.status !== 0, 'zero requested runs is not a success');
  assert(!none.output.includes('consecutive EMBY runs completed'), 'and announces nothing');
});

await test('both wrappers drive THIS gate, and neither one hides what it does not close', () => {
  // A WRAPPER POINTED AT THE WRONG GATE WOULD PASS EVERY BEHAVIOURAL CHECK ABOVE, because those run it against
  // a stub. What they cannot see is which script it defaults to when nobody overrides it.
  assert(THREE.includes('projection-emby-dataplane-gate.sh'), 'the three-run wrapper defaults to this gate');
  assert(OPTIONAL.includes('projection-emby-dataplane-gate.sh'), 'and so does the optional entry point');
  assert(THREE.includes('PROJECTION_EMBY_GATE_COMMAND'), 'the test seam is this gate\'s own variable');
  assert(OPTIONAL.includes('PROJECTION_EMBY_GATE_COMMAND'), 'in both');
  // AND THE HONEST LIMITS TRAVEL WITH THE WRAPPER OUTPUT, not only with the document. A caller reading a
  // green three-run transcript must be told, there, that it closes nothing on this platform.
  for (const limit of ['Linux', 'Unraid', 'Docker Desktop']) {
    assert(THREE.includes(limit), `the three-run wrapper names ${limit} among what bounds it`);
  }
  assert(THREE.includes('must not be reported as Phase 1 closure'), 'in those words');
  assert(OPTIONAL.includes('NOTHING WAS PROVED'), 'and the optional path is blunt about a skip');
});

await test('the optional entry point maps ONLY a skip to success', () => {
  const skipped = runWrapper('projection-emby-dataplane-gate-optional.sh', 77);
  assertEq(skipped.status, 0, 'a skip is success for a caller that chose this entry point');
  assert(skipped.output.includes('NOTHING WAS PROVED'), 'and it says so loudly');
  const broke = runWrapper('projection-emby-dataplane-gate-optional.sh', 1);
  assertEq(broke.status, 1, 'a real failure is still a failure here');
});

await test('the gate itself exits 77 rather than 0 when the host cannot host it', () => {
  assert(GATE.includes('GATE_SKIP_STATUS=77'), 'the skip status is 77');
  assert(GATE.includes('exit "$GATE_SKIP_STATUS"'), 'and the skip path exits with it');
  assert(GATE.includes('must not be reported as one'), 'and refuses to be read as a pass');
  // AND THE ONE SKIP CONDITION IS /dev/fuse. A second one would be a second way for a required acceptance
  // invocation to prove nothing while exiting 77.
  assertEq((GATE.match(/exit "\$GATE_SKIP_STATUS"/g) ?? []).length, 1, 'exactly one skip path');
  assert(GATE.includes('/dev/fuse is reachable from a container'), 'and it is the mount');
});

// ---------------------------------------------------------------------------------------------------------
// The gate script's shape, where a structural check is the right instrument
// ---------------------------------------------------------------------------------------------------------

await test('the gate uses the already-merged production image and a non-root reader', () => {
  assert(GATE.includes('docker build -t "$IMAGE" ./projectiond'), 'it builds the production image');
  assert(GATE.includes('--strict-direct-mount'), 'and mounts by syscall, refusing the fusermount helper');
  assert(GATE.includes('--user 65534:65534'), 'the baseline reader is an ordinary non-root user');
  assert(GATE.includes('recorded OUTSIDE the mount'),
    'and digests are recorded outside the thing being verified');
  // THE HONEST LIMITS TRAVEL WITH THE GATE OUTPUT, not only with the document.
  for (const limit of ['Unraid', 'Docker Desktop', 'three']) {
    assert(GATE.includes(limit), `the gate says ${limit} bounds what it closes`);
  }
});

await test('the media server is pinned by digest and its version is asserted at runtime', () => {
  assert(/EMBY_IMAGE="emby\/embyserver@sha256:[0-9a-f]{64}"/.test(GATE),
    'the media server is pinned by digest, not by a moving tag');
  assert(read('docker-compose.projection-emby.yml').includes('postgres:16@sha256:'),
    'and so is the database this gate stands up');
  assert(GATE.includes('golang:1.26.5-bookworm@sha256:'), 'and the toolchain');
  assert(GATE.includes('alpine@sha256:'), 'and the verifier');
  // A GATE WHOSE RECORDED BEHAVIOUR BELONGS TO A VERSION IT IS NO LONGER RUNNING READS LIKE EVIDENCE AND IS
  // NOT. Every measured finding in emby-dataplane.ts belongs to one version, so the gate asserts it meets it.
  assert(read('src/ops/projection-emby-dataplane-cli.ts').includes('EM1-pinned-version'),
    'the version the findings were measured against is asserted rather than assumed');
  assertEq(EMBY_PINNED_VERSION, '4.9.5.0', 'the version every finding in this suite was measured against');
});

await test('the decoder is the media server\'s own ffmpeg, at the path measured inside its image', () => {
  assertEq(EMBY_FFMPEG, '/bin/ffmpeg', 'measured with find(1) inside the pinned image');
  assertEq(EMBY_FFPROBE, '/bin/ffprobe', 'and its probe beside it');
  assert(GATE.includes('EMBY_FFMPEG="/bin/ffmpeg"'), 'the gate uses the measured path');
  assert(GATE.includes('EMBY_FFPROBE="/bin/ffprobe"'), 'and so does the decoder');
  // EVERY "PLAYABLE VIDEO" CLAIM IS MADE BY A DECODER OUTSIDE THE PROCESS THAT FETCHED THE BYTES. A phase
  // that both produced the bytes and pronounced them playable would be the shape of claim this repository is
  // trying to leave behind.
  assert(GATE.includes('drive seek-verify'), 'the seeks are decoded and then verified separately');
  assert(GATE.includes('drive transcode-soak-verify'), 'and so is the soak');
  assert(GATE.includes('drive paced-play-output'), 'and the paced consumer\'s own output is re-probed');
});

await test('the warm-window evidence is captured for every playback window', () => {
  // A PLAYBACK WINDOW CAN LEGITIMATELY REACH THE PROVIDER ZERO TIMES. "Zero provider requests" then has two
  // explanations that demand opposite responses, and only the daemon can say which — so it is asked, over
  // exactly the same window.
  for (const window of ['seeks', 'play', 'soak']) {
    assert(GATE.includes(`daemon_counters "$WORK/out/daemon-before-${window}.json"`),
      `the ${window} window captures the daemon's counters before it`);
    assert(GATE.includes(`daemon_counters "$WORK/out/daemon-after-${window}.json"`), 'and after it');
    assert(GATE.includes(`--daemon-before "$REL/out/daemon-before-${window}.json"`),
      `and hands them to the ${window} assertion`);
  }
  // The status surface it reads is loopback-only and reached by joining the daemon's own namespace, not by
  // relaxing where the daemon listens.
  assert(GATE.includes('"statusAddr": "127.0.0.1:9099"'), 'the daemon publishes on loopback only');
  assert(GATE.includes('--network "container:$MOUNT_CONTAINER"'),
    'and the reader joins its network namespace rather than a published port');
});

await test('the gate never binds the mount read-only, so what refuses a write is the daemon', () => {
  assert(GATE.includes('-v "$WORK/mnt:/media/projection:rslave"'),
    'the media server gets the mount bind-propagated');
  assert(!GATE.includes('/media/projection:ro'),
    'and NOT read-only, or the mutation refusal would be evidence about a Docker flag');
  assert(GATE.includes('the daemon is what refuses'), 'and the step says what it is measuring');
});

await test('the corpus is the acceptance plan\'s ~50 entries with one long source beside it', () => {
  assert(GATE.includes('CORPUS_COUNT=47'), 'forty-seven generated entries');
  assert(GATE.includes('--min-entries 50'), 'and the check demands the plan\'s fifty once anchors are added');
  assert(GATE.includes('SOAK_SECONDS=340'), 'one long source, longer than the five minutes G8 and G10 need');
  assert(GATE.includes('drive corpus-check'), 'the corpus is checked against itself before a server sees it');
  // TWO BYTE-IDENTICAL ENTRIES WOULD MAKE EVERY DIGEST COMPARISON DECORATIVE, because a read that returned
  // the wrong entry would still match.
  assert(GATE.includes('so no read could be mismatched'), 'and the anchors are asserted distinct');
  assert(GATE.includes('-gt 3145728'), 'the anchors are above the contract\'s single-probe threshold');
});

await test('the five-minute gates are five minutes of consumption, not of elapsed time', () => {
  assert(GATE.includes('--seconds 300'), 'the plan\'s five minutes');
  assert(GATE.includes('drive paced-play '), 'a paced direct play');
  assert(GATE.includes('drive transcode-soak '), 'and a paced transcode');
  const cli = read('src/ops/projection-emby-dataplane-cli.ts');
  // EACH OF THESE EXISTS TO FAIL A DIFFERENT WAY OF FAKING FIVE MINUTES.
  assert(cli.includes('paced-play-pacing-ratio-x100'), 'a drain-and-sleep sits in the hundreds');
  assert(cli.includes('paced-play-pacing-floor-x100'), 'a sleep-and-decode-nothing sits near zero');
  assert(cli.includes('paced-play-longest-stall-seconds'), 'and a freeze in the middle has the same endpoints');
  assert(cli.includes('transcode-soak-longest-arrival-gap-seconds'),
    'a five-minute span alone is satisfied by ten seconds of work and one late segment');
  assert(cli.includes('transcode-soak-late-window-decoded-seconds'), 'and by a dense start with a padded tail');
  assert(cli.includes('transcode-soak-distinct-segments'), 'and by one segment delivered fifty times');
});

await test('the transcode claim is decoded output, and encoder liveness is recorded not asserted', () => {
  const cli = read('src/ops/projection-emby-dataplane-cli.ts');
  // G10 IS RUN, NOT CLOSED. Asserting encoder liveness would either fail every correct run on this hardware
  // or overclaim what was measured, and this gate does neither.
  assert(cli.includes('RECORDED, NOT ASSERTED'), 'the encoder numbers are recorded under that description');
  assert(cli.includes('G10 is NOT closed'), 'and the limit is stated');
  // AND THE CLIENT-WRITABLE FIELD IS NEVER AUTHORED BY THIS GATE, which is the Jellyfin negative control's
  // conclusion inherited rather than re-derived: reporting `DirectPlay` made that server record `DirectPlay`
  // while a real transcode served the segments.
  // THE BAN IS ON THE SEND SITE, NOT ON THE WORD. The driver's comment quotes the field precisely so that a
  // reader knows which one is client-writable; banning the string would delete the explanation along with the
  // defect. What must be true is that the playback report the gate POSTs carries no such key.
  const driver = read('src/ops/projection-emby-dataplane.ts');
  const reportBody = driver.slice(driver.indexOf('await json(state, \'POST\', `/Sessions/${stage}`'));
  const posted = reportBody.slice(0, reportBody.indexOf('});'));
  assert(posted.length > 0, 'the playback report\'s body is findable');
  assert(!/PlayMethod/.test(posted),
    'the gate authors no PlayMethod in the playback report, so it never reads back a value it supplied');
  assert(cli.includes('client-writable'), 'and says why the field carries no assertion');
});

await test('the anonymous negative control is actually run, against both anchors', () => {
  assertEq((GATE.match(/drive anonymous-play/g) ?? []).length, 2,
    'the unauthorized request is issued against the local and the remote anchor');
  assert(GATE.includes('this server makes possible and Jellyfin does not'),
    'and the step says why only this gate can make the claim');
});

// ---------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------

await test('package, inventory and the aggregate run are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-emby-dataplane'], 'tsx test/projection-emby-dataplane.ts', 'test script');
  assertEq(pkg.scripts['go:emby-dataplane-gate'], 'bash deploy/projection-emby-dataplane-gate.sh', 'gate script');
  assertEq(pkg.scripts['go:emby-dataplane-gate:three'],
    'bash deploy/projection-emby-dataplane-gate-three.sh', 'three-run wrapper');
  assertEq(pkg.scripts['go:emby-dataplane-gate:optional'],
    'bash deploy/projection-emby-dataplane-gate-optional.sh', 'optional entry point');
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-emby-dataplane.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as {
    suites: Array<{ file: string; group: string }>;
  };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-emby-dataplane.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry?.group, 'offline', 'and needs no database');
});

await test('the gate has its own database, network and port, so it can run beside the other two', () => {
  const compose = read('docker-compose.projection-emby.yml');
  assert(compose.includes('name: projection-emby-gate'), 'its own Compose project');
  assert(compose.includes('PROJECTION_EMBY_GATE_PG_PORT:-5500'), 'its own port');
  assert(compose.includes('tmpfs:'), 'and throwaway storage, so three runs are three runs from nothing');
  // NOT THE PORTS THE OTHER GATES BIND. Three consecutive runs mean nothing if a previous run, another gate
  // or an installation can lend this one state.
  for (const taken of ['5432', '5470', '5480', '5490']) {
    assert(!compose.includes(`:-${taken}`), `it does not default to ${taken}, which another stack binds`);
  }
});

await test('an interrupted run cannot leave its scratch credential where git could reach it', () => {
  // THE GATE DELETES ITS RUN DIRECTORY ON SUCCESS AND ON FAILURE, and that is the mechanism. This is the belt
  // to that brace, and it matters more here than for the other two gates: because this server refuses an
  // unauthenticated direct play, the gate writes a throwaway access token into that directory for the paced
  // consumer to read. A `Ctrl-C` between the two leaves it on disk, and `git add -A` would take it.
  const ignore = read('.gitignore');
  assert(ignore.includes('.projection-emby-gate/'), 'the run directory is ignored');
  assert(ignore.includes('throwaway access token'), 'and the reason is recorded beside the entry');
  // AND THE GATE REALLY DOES REMOVE IT, on both paths.
  assert(GATE.includes('trap cleanup EXIT'), 'the cleanup runs on every exit');
  assert(/rm -rf "\$WORK"/.test(GATE), 'and removes the run directory');
});

await test('the daemon still names no media server, which this gate does not change', () => {
  // `test/projectiond-wiring.ts` refuses any Go file that names a media server. Nothing in this tranche is
  // compiled into, linked to, or read by the daemon, and that has to stay true for a third server too.
  const emby = read('src/core/projection/emby-dataplane.ts');
  assert(emby.includes('NOTHING HERE IS COMPILED INTO'), 'the module says so');
  assert(!existsSync(join(repoRoot, 'projectiond', 'internal', 'emby')),
    'and no Go package is named for this media server');
});

await test('the document exists and states what has NOT been proved', () => {
  const doc = read('docs/PROJECTION_PHASE_1_EMBY_DATA_PLANE.md');
  for (const limit of ['Unraid', 'Docker Desktop', 'three consecutive']) {
    assert(doc.includes(limit), `the document names ${limit} among what bounds it`);
  }
  assert(/##\s*\d+\.\s*The run record/i.test(doc),
    'and carries a run record separate from the description of what the gate asserts');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`\n${name}\n  ${(error as Error).stack ?? error}`);
  process.exit(1);
}
