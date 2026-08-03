import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MEDIA_SERVER_BUDGETS, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_SOAK, SEEK_PLAN_FRACTIONS,
  TRANSCODE_SOURCE_VIDEO_CODEC, TRANSCODE_TARGET_VIDEO_CODEC, analysePacedPlayback, analyseTranscodeSoak,
  analyseSeekSet, atLeast, corpusProblems, corpusSelfProblems, exactly, findRedactionProblems, opaqueRef,
  seekPlanProblems, seekPositionsFor, withinBudget,
  type CorpusExpectation, type GateResult, type SeekObservation, type SoakProbe, type SoakSegment,
  type TranscodeSessionSampleRecord,
} from '../core/projection/media-server-dataplane.js';
import {
  GateFailure, addMovieLibrary, appendResult, awaitFile, awaitServer, bootstrap, configureEncoding,
  directPlay, forcedTranscode, listMovies, mediaTimeSeekSet, openPinnedStream, pacedDirectPlay, rangeRead,
  readExpected, readResults, readState, resolveLibraryId, scanIsRunningNow, scanLibrary, transcodeSoak,
  writeState, type GateState, type ItemRecord,
} from './projection-jellyfin-dataplane.js';

// The Projection Phase 1 media-server data-plane gate, from the command line.
//
// IT IS A SEQUENCE OF PHASES RATHER THAN ONE RUN, because three of the gates are about what happens to a
// media server WHILE something else is done to the daemon underneath it — a successor published mid-stream, a
// SIGKILL mid-playback — and the something else is a publisher command and a `docker kill`. A single
// self-contained run would have had to learn to drive Docker and PostgreSQL, and then the interesting half of
// the gate would be a mock of the shell script it replaced.
//
// EVERY PHASE APPENDS ITS VERDICTS to one results file, and `report` prints them, checks them against the
// acceptance plan's redaction rule, and exits non-zero if any gate failed. A phase that throws exits 1 with a
// message; nothing here retries forever and nothing here waits without a deadline.
//
//   bootstrap    --state F --base URL                      stand the server up through its own first-run API
//   library      --state F --mount-path P --name N          add the projected mount as a Movies library
//   scan         --state F --expect-file F --out F [--label L]
//   play         --state F --items F --key K --expect-file F
//   seek         --state F --items F --key K --expect-file F --offset N --length N
//   transcode    --state F --items F --key K --out-segment F
//   hold-stream  --state F --items F --key K --ready F --release F --expect-file F [--allow-interrupt]
//   compare      --before F --after F --gate G [--expect-added N]
//   counters     --url U --out F
//   budget       --before F --after F --gate G --entries N --bytes N [--small-bytes N] [--windows N]
//   report       --results F [--json F]
//
// ...and the five-minute half, which is where G8, G9 and G10 of the acceptance plan actually live:
//
//   corpus-check --expect-file F --min-entries N --min-remote N
//   configure-encoding --state F --temp-path P [--throttle-seconds N]
//   paced-play   --state F --items F --key K --image I --network N --container-name C --work-dir D
//                --stream-base U --output-rel P --ffmpeg P --trace F [--seconds N]
//   paced-play-output  --probed-seconds N --probed-packets N [--seconds N]
//   media-seeks  --state F --items F --key K --duration-seconds N --segment-dir D --out F
//   seek-verify  --key K --seeks F --probes F
//   transcode-soak       --state F --items F --key K --segment-dir D --producer-dir D --out F [--seconds N]
//   transcode-soak-verify --key K --items F --soak F --probes F [--seconds N]
//   traffic-window --before F --after F --gate G --object-bytes N [--max-object-multiplier N]
//
// THE DECODING IS NOT IN HERE, ON PURPOSE. Every "playable video" claim this gate makes is made by a real
// decoder in a separate container, over files these phases wrote; the `*-verify` phases hold that decoder's
// answers against the acceptance plan. A phase that both produced the bytes and pronounced them playable
// would be the shape of claim this repository is trying to leave behind.

interface Args { readonly command: string; readonly flags: ReadonlyMap<string, string> }

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0] ?? '';
  const flags = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    const value = eq === -1 ? argv[++index] : token.slice(eq + 1);
    if (value === undefined) fail(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { command, flags };
}

function fail(message: string): never {
  console.error(`projection-jellyfin-dataplane: ${message}`);
  process.exit(1);
}

function need(args: Args, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined) fail(`--${name} is required`);
  return value;
}

function optionalNumber(args: Args, name: string, fallback: number): number {
  const raw = args.flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`--${name} is not a number`);
  return value;
}

function itemFor(items: readonly ItemRecord[], key: string): ItemRecord {
  const found = items.find((item) => item.key === key);
  if (!found) throw new GateFailure(`the library has no item whose file is "${key}"`);
  return found;
}

function readItems(path: string): ItemRecord[] {
  return JSON.parse(readFileSync(path, 'utf8')) as ItemRecord[];
}

/**
 * The claim the whole appliance rests on, as one predicate: a media server sees a file on a disk.
 *
 * It was inline in the scan phase when there were two entries to check. It is a named function now because a
 * ~50-entry corpus is checked in aggregate and two anchors are checked individually, and two spellings of
 * "ordinary" would eventually disagree — with the aggregate, which covers every entry, being the one nobody
 * would notice had drifted.
 */
function isOrdinaryFile(item: ItemRecord): boolean {
  return item.protocol === 'File' && !item.isRemote && !item.key.endsWith('.strm')
    && item.container !== '' && item.locationType === 'FileSystem' && item.supportsDirectPlay;
}

/**
 * One counter, refused rather than coerced when it is not a whole non-negative count.
 *
 * A `NaN` out of a malformed counters file makes every budget below it fail, and the failure blames the data
 * plane for a broken instrument. Naming it here means the instrument is what fails.
 */
function counterValue(snapshot: Record<string, unknown>, key: string): number {
  const raw = snapshot[key];
  if (raw === undefined) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    fail(`the counter ${key} is ${JSON.stringify(raw)}, which is not a whole non-negative count. Every `
      + 'budget reading it would fail against NaN and blame the data plane for a broken counters file');
  }
  return raw;
}

/**
 * What the DAEMON's own playback cache did over a window, read from two `/readyz` documents.
 *
 * WHY THIS ARRIVED LATE, AND WHAT IT COST TO FIND OUT. This gate asserted an unconditional floor of one
 * provider request on every playback traffic window, on the reasoning that a window which never reached the
 * provider must have been served by something other than the daemon. A daemon repair made that false: once a
 * handle release stopped deleting the playback cache, an object that fits in memory is served from memory on
 * every later open. The Plex gate hit this, diagnosed it and replaced its floors; **this gate was never
 * re-run against the repaired daemon**, so it kept an inference that had already been invalidated — and
 * failed at `JD18-paced-play-traffic-range-requests-floor` measuring **0 against 1**, in a run where
 * independent decoders proved 300 s of real playback.
 *
 * THE FLOOR IS NOT DROPPED. A zero-provider window now has to be EXPLAINED: the daemon's own cumulative
 * playback-cache counters, over exactly the same window, must show it served the bytes. Zero provider traffic
 * with no daemon evidence is still a failure, and it is the same failure the old floor was aimed at.
 *
 * WHAT IT REFUSES, and none of it is pedantry: absent snapshots (a caller that measured nothing has proved
 * nothing); a missing `playback` object (a daemon too old to publish these reads as all-zero through a
 * forgiving parser, which is indistinguishable from one that served nothing); and a NEGATIVE delta, which
 * means the daemon RESTARTED inside the window — this gate restarts it on purpose elsewhere in the same run.
 */
interface WarmCacheEvidence {
  present: boolean;
  coherent: boolean;
  hits: number;
  hitBytes: number;
  coherenceNote: string;
}

function readWarmCacheEvidence(args: Args): WarmCacheEvidence {
  const beforePath = args.flags.get('daemon-before');
  const afterPath = args.flags.get('daemon-after');
  const absent: WarmCacheEvidence = {
    present: false, coherent: false, hits: 0, hitBytes: 0,
    coherenceNote: 'no daemon cache snapshots were supplied for this window, so nothing here can say what '
      + 'served it. Pass --daemon-before and --daemon-after',
  };
  if (beforePath === undefined || afterPath === undefined) return absent;
  if (!existsSync(beforePath) || !existsSync(afterPath)) {
    return { ...absent, coherenceNote: 'a daemon cache snapshot named for this window is missing from disk' };
  }
  const read = (path: string): { hits: number; hitBytes: number; misses: number } | undefined => {
    const document = JSON.parse(readFileSync(path, 'utf8')) as { playback?: Record<string, unknown> };
    if (document.playback === undefined || document.playback === null) return undefined;
    return {
      hits: counterValue(document.playback, 'hits'),
      hitBytes: counterValue(document.playback, 'hitBytes'),
      misses: counterValue(document.playback, 'misses'),
    };
  };
  const before = read(beforePath);
  const after = read(afterPath);
  if (before === undefined || after === undefined) {
    return {
      ...absent, present: true,
      coherenceNote: 'a daemon status document carries no `playback` counters, so this daemon cannot report '
        + 'what its playback cache served',
    };
  }
  const hits = after.hits - before.hits;
  const hitBytes = after.hitBytes - before.hitBytes;
  const misses = after.misses - before.misses;
  if (hits < 0 || hitBytes < 0 || misses < 0) {
    return {
      present: true, coherent: false, hits: 0, hitBytes: 0,
      coherenceNote: `a cumulative counter fell across this window (hits ${hits}, bytes ${hitBytes}, misses `
        + `${misses}), which only happens when the daemon RESTARTED inside it; the two readings are from `
        + 'different processes and their difference describes neither',
    };
  }
  return {
    present: true, coherent: true, hits, hitBytes,
    coherenceNote: `daemon playback cache over this window: ${hits} hits, ${hitBytes} bytes, ${misses} misses`,
  };
}

function record(args: Args, result: GateResult): void {
  const path = args.flags.get('results');
  if (path !== undefined) appendResult(path, result);
  const measured = result.measured === undefined ? '' : ` measured=${result.measured} budget=${result.budget}`;
  console.log(`  ${result.verdict.toUpperCase()}  ${result.gate}${measured}${result.note ? ` — ${result.note}` : ''}`);
  if (result.verdict === 'fail') throw new GateFailure(`${result.gate} failed`);
}

// ---------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'bootstrap': {
      // The credential is generated here and never printed. It lives in the state file, inside the gate's own
      // run directory, which the gate deletes on the way out — success or failure.
      // A RE-BOOTSTRAP AFTER A SERVER RESTART IS THE SAME INSTALLATION. The wizard is already complete, so
      // this is an ordinary login — and the library the previous state file named is carried forward, because
      // the whole point of the restart phase is that the server still has it. Re-deriving it here would be
      // asking the server the question this gate is supposed to be answering.
      const statePath = need(args, 'state');
      const previous = existsSync(statePath) ? readState(statePath) : undefined;
      const state: GateState = { baseUrl: need(args, 'base') };
      if (previous?.libraryId !== undefined) state.libraryId = previous.libraryId;
      if (previous?.libraryName !== undefined) state.libraryName = previous.libraryName;
      const version = await awaitServer(state);
      console.log(`  the media server answered; version ${version}`);
      // ONE PASSWORD PER STATE FILE, derived rather than random, so a re-bootstrap after a restart can log in
      // to the account the first one created. A fresh random each time would create an account the second run
      // could not authenticate against, and the failure would look like "the restart lost the user".
      const password = `g${opaqueRef('password', statePath)}`;
      await bootstrap(state, 'projection-gate', password);
      writeState(statePath, state);
      if (!existsSync(statePath)) fail('the bootstrap wrote no state file');
      record(args, { gate: 'JD1-bootstrap', verdict: 'pass', note: `server version ${version}` });
      return;
    }

    case 'library': {
      const state = readState(need(args, 'state'));
      await addMovieLibrary(state, need(args, 'mount-path'), need(args, 'name'));
      writeState(need(args, 'state'), state);
      record(args, {
        gate: 'JD2-library', verdict: 'pass',
        note: 'the library exists and points at the projected mount',
      });
      return;
    }

    case 'scan': {
      const state = readState(need(args, 'state'));
      const expected = readExpected(need(args, 'expect-file'));
      // THE SYNCHRONISATION POINT FOR THE MID-SCAN GATE. When asked for, this file is written the moment the
      // scanner is observed IN FLIGHT — not after a sleep, which is what the mid-scan race used to rely on.
      // The publishing half of the gate waits on it, so "a generation was admitted while a scan was running"
      // is an observation rather than a hope.
      const runningMarker = args.flags.get('running-marker');
      const outcome = await scanLibrary(state, runningMarker === undefined ? undefined : () => {
        mkdirSync(runningMarker.replace(/[^/\\]*$/, '') || '.', { recursive: true });
        writeFileSync(runningMarker, `running\n`);
      });
      const elapsed = outcome.elapsedMs;
      // The library ITEM only exists once a scan has run, so this is the first point at which the id can be
      // picked up. Once known it is persisted, and every later listing is scoped to it.
      await resolveLibraryId(state);
      writeState(need(args, 'state'), state);
      const items = await listMovies(state);
      writeFileSync(need(args, 'out'), `${JSON.stringify(items, null, 2)}\n`);
      const label = args.flags.get('label') ?? 'scan';

      // A TOLERANT SCAN IS ONE THE GATE DELIBERATELY RACED. When a successor is published WHILE a scan is
      // running, the scan may legitimately have seen the predecessor's namespace, the successor's, or a
      // mixture — and asserting a count against either would be asserting the outcome of a race. What must
      // hold is checked by the STRICT scan that follows: it converges on the successor, with zero removals
      // and zero item-id churn for everything carried. Recording what the raced scan saw is still worth
      // doing; pretending it was deterministic is not.
      if (args.flags.get('tolerant') === 'true') {
        // THE RACE MUST HAVE BEEN A RACE. If the scanner was never observed in flight, the publish that the
        // other half of the gate performed cannot be claimed to have landed mid-scan.
        // IN FLIGHT, NOT MERELY "AN EXECUTION HAPPENED". A scan that started and finished between two polls
        // satisfies the second and not the first, and only the first can support "a generation was admitted
        // WHILE a scan was running".
        record(args, {
          gate: `JD3-${label}-scan-observed-in-flight`,
          verdict: outcome.observedInFlight ? 'pass' : 'fail',
          note: 'the scanner was seen actually running; a fast-complete between polls would not count',
        });
        record(args, {
          gate: `JD3-${label}-raced-scan-completed`, verdict: 'pass',
          note: `a scan raced against a publish completed in ${Math.round(elapsed / 1000)}s and returned a `
            + `well-formed listing of ${items.length}; what it saw is not asserted, and the next scan is`,
        });
        for (const item of items) {
          // Whatever it saw must at least be coherent: no item with a missing source or a nonsense size.
          record(args, {
            gate: `JD3-${label}-raced-item-coherent:${opaqueRef('entry', item.key).slice(0, 12)}`,
            verdict: item.sizeBytes > 0 && item.protocol === 'File' && !item.isRemote ? 'pass' : 'fail',
            note: `a mid-scan generation change must not produce a half-formed item`,
          });
        }
        return;
      }

      record(args, exactly(`JD3-${label}-item-count`, items.length, expected.length,
        `the scan took ${Math.round(elapsed / 1000)}s`));

      // THE WHOLE CORPUS, IN ONE PASS, AS A COUNT OF MATCHED IDENTITIES.
      //
      // WHY AGGREGATE AT ALL. Fifty entries times four properties times seven scans is fourteen hundred
      // report lines, and §7 asks for a report an operator reads rather than one they scroll past.
      //
      // WHY IT IS STILL NOT A COUNT. `matched` is the number of PUBLISHED keys that were present, at the
      // published size, as an ordinary file — so `JD3-corpus-matched 50/50` cannot be satisfied by fifty
      // arbitrary items the way an item count can. The three problem counters beside it name what went wrong
      // when it is not fifty, which a bare match count would leave undiagnosable.
      const problems = corpusProblems(expected, items.map((item) => ({
        key: item.key,
        sizeBytes: item.sizeBytes,
        ordinaryFile: isOrdinaryFile(item),
      })));
      record(args, exactly(`JD3-${label}-corpus-matched`, problems.matched, expected.length,
        'published identities the server catalogued at the published size as ordinary files'));
      record(args, exactly(`JD3-${label}-corpus-missing`, problems.missing, 0));
      record(args, exactly(`JD3-${label}-corpus-wrong-size`, problems.wrongSize, 0));
      record(args, exactly(`JD3-${label}-corpus-not-ordinary`, problems.notOrdinary, 0,
        'not a symlink, not a .strm placeholder, not a remote media source: a file on a disk'));
      record(args, exactly(`JD3-${label}-corpus-duplicated`, problems.duplicated, 0));
      record(args, exactly(`JD3-${label}-corpus-unexpected`, problems.unexpected, 0));

      // AND THE ANCHORS INDIVIDUALLY. These are the entries whose BYTES are also read back and digest-
      // compared elsewhere; naming them one at a time keeps the per-entry evidence the two-entry version of
      // this gate had, for the entries it had it for.
      for (const want of expected.filter((entry) => entry.anchor === true)) {
        const item = itemFor(items, want.key);
        // THE MEDIA SERVER'S OWN VIEW OF THE FILE, checked against what was published — size from its probe,
        // not from a stat this gate did itself.
        record(args, exactly(`JD3-${label}-size:${opaqueRef('entry', want.key).slice(0, 12)}`,
          item.sizeBytes, want.sizeBytes));
        // ORDINARY FILES. Not a symlink, not a `.strm` placeholder pointing somewhere else, not a remote
        // media source the server would fetch over HTTP itself. This is the claim the whole appliance rests
        // on: a media server treats the projection as a disk.
        record(args, {
          gate: `JD3-${label}-ordinary-file:${opaqueRef('entry', want.key).slice(0, 12)}`,
          verdict: isOrdinaryFile(item) ? 'pass' : 'fail',
          note: `protocol=${item.protocol} container=${item.container} remote=${item.isRemote} `
            + `location=${item.locationType} directPlay=${item.supportsDirectPlay}`,
        });
      }
      return;
    }

    case 'play': {
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const want = readExpected(need(args, 'expect-file')).find((entry) => entry.key === key);
      if (!want) fail(`no expectation was recorded for "${key}"`);
      const item = itemFor(items, key);
      const result = await directPlay(state, item, want.sizeBytes);
      record(args, exactly(`JD4-direct-play-bytes:${opaqueRef('entry', key).slice(0, 12)}`,
        result.bytes, want.sizeBytes));
      record(args, {
        gate: `JD4-direct-play-digest:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: result.sha256 === want.sha256 ? 'pass' : 'fail',
        note: `${want.kind} source; digest recorded outside the mount`,
      });
      return;
    }

    case 'seek': {
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const item = itemFor(items, key);
      const offset = optionalNumber(args, 'offset', 0);
      const length = optionalNumber(args, 'length', 65_536);
      const result = await rangeRead(state, item, offset, length);
      const expectedDigest = need(args, 'expect-sha');
      record(args, exactly(`JD5-seek-206-bytes:${opaqueRef('entry', key).slice(0, 12)}`, result.bytes, length,
        `Content-Range asserted before the body was read`));
      record(args, {
        gate: `JD5-seek-digest:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: result.sha256 === expectedDigest ? 'pass' : 'fail',
        note: `offset ${offset}, length ${length}`,
      });
      return;
    }

    case 'transcode': {
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const item = itemFor(items, key);
      const maxSegments = optionalNumber(args, 'max-segments', 3);
      const maxBytes = optionalNumber(args, 'max-bytes', 32 * 1024 * 1024);
      const result = await forcedTranscode(state, item, maxSegments, maxBytes);

      // THE SOURCE MUST BE WHAT THE GATE THINKS IT IS. If the media were already h264, asking for h264 would
      // let the server remux and the transcode claim would be empty. This is asserted rather than assumed.
      record(args, {
        gate: `JD6-transcode-source-codec:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: item.videoCodec === TRANSCODE_SOURCE_VIDEO_CODEC ? 'pass' : 'fail',
        note: `the server identified the source as ${item.videoCodec || '(none)'}; `
          + `the gate asks for ${TRANSCODE_TARGET_VIDEO_CODEC}`,
      });
      // Every requested segment must have arrived with bytes in it. `measured` and `budget` are both present
      // or both absent, because a report line reading "2/undefined" is not a measurement against anything.
      record(args, exactly(`JD6-transcode-segments:${opaqueRef('entry', key).slice(0, 12)}`,
        result.segments, maxSegments, `${result.bytes} bytes of transcoded output consumed`));
      record(args, {
        gate: `JD6-transcode-output-nonempty:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: result.bytes > 0 && result.firstSegment.byteLength > 0 ? 'pass' : 'fail',
        measured: result.bytes,
      });
      // LEAST EXPOSURE, MEASURED AT RUNTIME. The gate authors no URL containing a credential; this asserts
      // the server did not hand one back either, in the playlists it generated from a header-authenticated
      // request. Anything it had found would have been stripped before the URL was followed.
      record(args, exactly(`JD6-no-credential-in-generated-urls:${opaqueRef('entry', key).slice(0, 12)}`,
        result.credentialsInGeneratedUrls, 0,
        'server-generated playlist URLs carried no api key, so no credential propagated into a playlist body'));
      // Corroboration, recorded rather than relied on: the decode assertion is the evidence, and it happens
      // outside this process because the thing that can decode a transport stream is ffprobe.
      record(args, {
        gate: `JD6-transcode-session-reported:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: 'pass',
        note: `session reported transcoding=${result.sessionSawTranscode}`
          + `${result.transcodeReasons.length ? ` reasons=${result.transcodeReasons.join('|')}` : ''}`,
      });
      const out = need(args, 'out-segment');
      mkdirSync(out.replace(/[^/\\]*$/, '') || '.', { recursive: true });
      writeFileSync(out, result.firstSegment);
      console.log(`  wrote ${result.firstSegment.byteLength} bytes of transcoded output for decoding`);
      return;
    }

    case 'configure-encoding': {
      // Where the encoder writes, and that it must pace itself to its client. See `configureEncoding` for
      // why the five-minute transcode gate cannot be measured without both.
      const state = readState(need(args, 'state'));
      await configureEncoding(state, need(args, 'temp-path'),
        optionalNumber(args, 'throttle-seconds', 30));
      record(args, {
        gate: 'JD17-encoder-configured', verdict: 'pass',
        note: 'the transcoding job writes where the gate can observe it, and throttles to its client',
      });
      return;
    }

    case 'corpus-check': {
      // THE CORPUS CHECKED AGAINST ITSELF, BEFORE A MEDIA SERVER IS INVOLVED. Two entries with the same bytes
      // make every digest comparison in this gate decorative, and a ~50-entry corpus is generated by a loop —
      // which is exactly the thing that could quietly start emitting identical parameters.
      const expected = readExpected(need(args, 'expect-file')) as readonly CorpusExpectation[];
      const problems = corpusSelfProblems(expected);
      record(args, exactly('JD3-corpus-self-distinct', problems.length, 0,
        problems.length === 0
          ? `${expected.length} entries, every one a distinct name, size-bearing and distinctly digested`
          : problems.join('; ')));
      record(args, atLeast('JD3-corpus-size', expected.length, optionalNumber(args, 'min-entries', 50),
        'the acceptance plan\'s ~50-entry corpus'));
      const remote = expected.filter((entry) => entry.kind === 'http-range').length;
      record(args, atLeast('JD3-corpus-remote-entries', remote, optionalNumber(args, 'min-remote', 1),
        'entries whose bytes only exist behind the HTTP Range provider'));
      return;
    }

    case 'paced-play': {
      // G8: "Direct play starts within 10 s and runs 5 minutes without a stall."
      //
      // WHAT MAKES THIS DIFFERENT FROM THE `play` PHASE ABOVE. That one proves the BYTES are right: it drains
      // the whole response and digests it, which takes a second or two. It cannot prove anything about five
      // minutes, and adding a sleep to it would have produced a phase that took five minutes and measured a
      // download. This one runs a real decoder at the media's own rate and holds its progress trace against
      // four separate numbers, three of which exist specifically to fail the ways the first one can be faked.
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const item = itemFor(items, key);
      const ref = opaqueRef('entry', key).slice(0, 12);
      const seconds = optionalNumber(args, 'seconds', MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS);

      const outcome = await pacedDirectPlay({
        image: need(args, 'image'),
        network: need(args, 'network'),
        containerName: need(args, 'container-name'),
        workDir: need(args, 'work-dir'),
        // The stream URL is built here and goes nowhere else: not into a result, not into a note, not into a
        // failure message. `withoutLocators` scrubs the consumer's own stderr for the same reason.
        streamUrl: `${need(args, 'stream-base')}/Videos/${item.itemId}/stream`
          + `?static=true&mediaSourceId=${encodeURIComponent(item.mediaSourceId)}`,
        outputRelPath: need(args, 'output-rel'),
        seconds,
        ffmpegPath: need(args, 'ffmpeg'),
      });
      if (outcome.exitCode !== 0) {
        throw new GateFailure(`the paced consumer exited ${outcome.exitCode}: ${outcome.stderr.slice(-600)}`);
      }
      const analysis = analysePacedPlayback(outcome.samples);
      writeFileSync(need(args, 'trace'), `${JSON.stringify(outcome.samples, null, 2)}\n`);

      record(args, atLeast(`JD18-paced-play-samples:${ref}`, analysis.samples, 30,
        'progress records from the decoder itself, roughly one a second'));
      record(args, withinBudget(`JD18-paced-play-startup-seconds:${ref}`,
        Math.round(analysis.startupSeconds * 10) / 10, MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS,
        'from launching the consumer to its first decoded frame'));
      record(args, atLeast(`JD18-paced-play-wall-seconds:${ref}`,
        Math.floor(analysis.wallSeconds), seconds));
      // THE ONE A SLEEP CANNOT PASS. Wall clock is what a sleep buys; this is decoded media time, reported by
      // the decoder, and five minutes of it cannot be produced by waiting.
      record(args, atLeast(`JD18-paced-play-decoded-media-seconds:${ref}`,
        Math.floor(analysis.mediaSeconds), seconds,
        'media the consumer actually decoded, not wall clock it spent'));
      // ...AND THE ONE A FAST DRAIN CANNOT PASS. A consumer that downloaded the file as fast as the socket
      // allowed and then slept has the same two numbers above and a ratio in the hundreds.
      record(args, withinBudget(`JD18-paced-play-pacing-ratio-x100:${ref}`,
        Math.round(analysis.pacingRatio * 100), Math.round(MEDIA_SERVER_SOAK.MAX_PACING_RATIO * 100),
        'decoded media seconds per wall second: a player is ~100, a download is thousands'));
      record(args, atLeast(`JD18-paced-play-pacing-floor-x100:${ref}`,
        Math.round(analysis.pacingRatio * 100), Math.round(MEDIA_SERVER_SOAK.MIN_PACING_RATIO * 100),
        'and a consumer that slept through the window sits near zero'));
      record(args, withinBudget(`JD18-paced-play-longest-stall-seconds:${ref}`,
        Math.round(analysis.longestStallSeconds), MEDIA_SERVER_SOAK.MAX_STALL_SECONDS,
        'the longest wall interval in which the decoder made no progress at all'));
      return;
    }

    case 'paced-play-output': {
      // The consumer's own output, decoded by a decoder outside this process. "Playable output" is a
      // decoder's answer; a byte count is not one.
      const seconds = optionalNumber(args, 'seconds', MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS);
      record(args, atLeast('JD18-paced-play-output-seconds', optionalNumber(args, 'probed-seconds', 0),
        Math.floor(seconds * 0.98), 'the decoded output re-probed end to end'));
      record(args, atLeast('JD18-paced-play-output-packets', optionalNumber(args, 'probed-packets', 0), 1,
        'the output has decodable video packets in it'));
      return;
    }

    case 'media-seeks': {
      // G9: "Ten seeks, including backwards and to > 90 % of duration, each producing playable video
      // within 10 s."
      //
      // WHAT A SEEK IS AGAINST THIS SERVER, MEASURED RATHER THAN GUESSED. One HLS session, one playlist, and
      // ten out-of-order requests for the segments at the positions wanted -- which is what a player does
      // when somebody drags a scrubber, and what makes the server restart its encoder at a new position.
      // See `SEEK_IS_A_DIRECT_SEGMENT_REQUEST` for the two measurements that ruled out `startTimeTicks`.
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const item = itemFor(items, key);
      const ref = opaqueRef('entry', key).slice(0, 12);
      const duration = optionalNumber(args, 'duration-seconds', 0);
      if (duration <= 0) fail('--duration-seconds is required and must be positive');

      // THE PLAN IS CHECKED BEFORE IT IS RUN. Every per-seek assertion would pass just as happily against ten
      // seeks into the first minute; the properties that make the SET worth running belong to the list, and
      // nothing that watches one seek at a time can see them.
      const planProblems = seekPlanProblems(SEEK_PLAN_FRACTIONS);
      record(args, exactly(`JD19-seek-plan:${ref}`, planProblems.length, 0,
        planProblems.length === 0
          ? 'ten distinct positions, four transitions backwards, two beyond 90% of duration'
          : planProblems.join('; ')));

      const positions = seekPositionsFor(duration);
      const outcome = await mediaTimeSeekSet(state, item, positions,
        `gate-seek-${opaqueRef('session', key).slice(0, 16)}`);
      const segmentDir = need(args, 'segment-dir');
      mkdirSync(segmentDir, { recursive: true });
      outcome.segments.forEach((segment, index) => {
        writeFileSync(`${segmentDir}/seek-${String(index).padStart(2, '0')}.ts`, segment);
      });
      writeFileSync(need(args, 'out'), `${JSON.stringify({
        seeks: outcome.seeks,
        playlistSeconds: outcome.playlistSeconds,
        durationSeconds: duration,
        credentialsInGeneratedUrls: outcome.credentialsInGeneratedUrls,
      }, null, 2)}
`);

      // THE PER-SEEK CEILING, which is the half of G9 that is about a viewer waiting for a picture.
      for (const seek of outcome.seeks) {
        record(args, withinBudget(`JD19-seek-${seek.index}-seconds:${ref}`,
          Math.round(seek.elapsedMs / 100) / 10, MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS,
          `to ${Math.round((seek.requestedSeconds / duration) * 100)}% of duration`));
      }
      record(args, exactly(`JD19-seek-count:${ref}`, outcome.seeks.length, MEDIA_SERVER_SOAK.SEEK_COUNT));
      record(args, exactly(`JD19-seek-no-credential-in-generated-urls:${ref}`,
        outcome.credentialsInGeneratedUrls, 0));
      // The server's own playlist has to describe the media the gate thinks it is seeking around, or every
      // position below was computed against the wrong duration.
      record(args, withinBudget(`JD19-seek-playlist-duration-drift-seconds:${ref}`,
        Math.round(Math.abs(outcome.playlistSeconds - duration)), 5,
        `the server's playlist describes ${Math.round(outcome.playlistSeconds)}s and the file decodes as `
        + `${duration}s`));
      return;
    }

    case 'seek-verify': {
      // THE PROPERTIES THAT BELONG TO THE SET, held against the acceptance plan once the segments have been
      // decoded by a real decoder. Every per-seek assertion above is satisfied by a server that returned the
      // first three seconds of the file ten times; none of these is.
      const key = need(args, 'key');
      const ref = opaqueRef('entry', key).slice(0, 12);
      const raw = JSON.parse(readFileSync(need(args, 'seeks'), 'utf8')) as {
        seeks: SeekObservation[]; durationSeconds: number;
      };
      const decodes = (JSON.parse(readFileSync(need(args, 'probes'), 'utf8')) as SoakProbe[])
        .map((probe) => ({
          index: probe.index, codec: probe.codec, packets: probe.packets, startSeconds: probe.seconds,
        }));
      const analysis = analyseSeekSet(raw.seeks, decodes);

      record(args, exactly(`JD19-seek-decoded-count:${ref}`, analysis.count - analysis.unprobed,
        MEDIA_SERVER_SOAK.SEEK_COUNT, 'every seek position was decoded, not a sample of them'));
      record(args, exactly(`JD19-seek-wrong-codec:${ref}`, analysis.wrongCodec, 0,
        `every seek produced ${TRANSCODE_TARGET_VIDEO_CODEC} from an ${TRANSCODE_SOURCE_VIDEO_CODEC} source`));
      record(args, exactly(`JD19-seek-empty-of-video:${ref}`, analysis.emptyOfVideo, 0,
        'a segment with no decodable video packets is not playable video'));
      record(args, withinBudget(`JD19-seek-slowest-seconds:${ref}`,
        Math.round(analysis.slowestSeconds * 10) / 10, MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS));
      // TEN SEEKS, NOT ONE SEEK TEN TIMES.
      record(args, exactly(`JD19-seek-distinct-segments:${ref}`, analysis.distinctSegments,
        MEDIA_SERVER_SOAK.SEEK_COUNT, 'ten different segments came back, byte for byte'));
      record(args, atLeast(`JD19-seek-backward-transitions:${ref}`, analysis.backwardTransitions,
        MEDIA_SERVER_SOAK.MIN_BACKWARD_SEEKS, 'the plan really did go backwards, in the order it was run'));
      record(args, atLeast(`JD19-seek-past-90-percent:${ref}`, analysis.deepSeeks, 1));
      record(args, withinBudget(`JD19-seek-position-error-seconds:${ref}`,
        Math.round(analysis.maxPositionErrorSeconds * 10) / 10,
        MEDIA_SERVER_SOAK.MAX_SEEK_POSITION_ERROR_SECONDS,
        'the worst gap between the position asked for and the one the server said it was serving'));
      // THE TEMPORAL ASSERTION. The decoded timestamps move one second per second of media asked for; the
      // constant offset between them is one server's presentation-time base and is measured, not assumed.
      record(args, withinBudget(`JD19-seek-decoded-offset-spread-x10:${ref}`,
        Math.round(analysis.decodedOffsetSpreadSeconds * 10),
        Math.round(MEDIA_SERVER_SOAK.MAX_SEEK_DECODED_OFFSET_SPREAD_SECONDS * 10),
        'how much the decoded-timestamp offset varied across the ten seeks; a server that ignored the '
        + 'position would vary by the whole duration'));
      record(args, atLeast(`JD19-seek-decoded-span-seconds:${ref}`,
        Math.floor(analysis.decodedSpanSeconds),
        Math.floor(raw.durationSeconds * MEDIA_SERVER_SOAK.MIN_SEEK_DECODED_SPAN_FRACTION),
        'the media the ten decoded segments actually covered, end to end'));
      return;
    }

    case 'transcode-soak': {
      // G10: "A forced transcode runs 5 minutes."
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const item = itemFor(items, key);
      const seconds = optionalNumber(args, 'seconds', MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS);
      const outcome = await transcodeSoak(state, item, {
        segmentDir: need(args, 'segment-dir'),
        producerDir: need(args, 'producer-dir'),
        minSeconds: seconds,
        maxSegmentBytes: optionalNumber(args, 'max-segment-bytes', 8 * 1024 * 1024),
      });
      writeFileSync(need(args, 'out'), `${JSON.stringify({
        segments: outcome.segments,
        sessions: outcome.sessions,
        producerMtimesMs: outcome.producerMtimesMs,
        credentialsInGeneratedUrls: outcome.credentialsInGeneratedUrls,
        failedPlaybackReports: outcome.failedPlaybackReports,
        failedSessionPolls: outcome.failedSessionPolls,
      }, null, 2)}\n`);
      console.log(`  consumed ${outcome.segments.length} segment(s) over `
        + `${Math.round((outcome.segments[outcome.segments.length - 1]?.wallMs ?? 0) / 1000)}s`);
      return;
    }

    case 'transcode-soak-verify': {
      // WHAT THIS GATE CLAIMS, IN ONE SENTENCE, SO THAT THE ASSERTIONS CAN BE READ AGAINST IT: five minutes
      // of PACED, CONTINUOUSLY DECODED, TRANSCODED PLAYBACK. Not five minutes of an encoder process being
      // busy — see the encoder span below, which is recorded and is not that.
      const key = need(args, 'key');
      const ref = opaqueRef('entry', key).slice(0, 12);
      const raw = JSON.parse(readFileSync(need(args, 'soak'), 'utf8')) as {
        segments: SoakSegment[];
        sessions: TranscodeSessionSampleRecord[];
        producerMtimesMs: number[];
        credentialsInGeneratedUrls: number;
        failedPlaybackReports: number;
        failedSessionPolls: number;
      };
      const probes = JSON.parse(readFileSync(need(args, 'probes'), 'utf8')) as SoakProbe[];
      const seconds = optionalNumber(args, 'seconds', MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS);
      const analysis = analyseTranscodeSoak(raw.segments, probes, raw.producerMtimesMs, raw.sessions);

      record(args, atLeast(`JD20-transcode-soak-wall-seconds:${ref}`,
        Math.floor(analysis.wallSpanSeconds), seconds,
        'wall clock between the first segment arriving and the last, at a player\'s pace'));
      // THE ONE THAT TURNS AN ELAPSED WINDOW INTO A CONTINUOUS ONE. A five-minute span is satisfied by
      // consuming everything in ten seconds and fetching one last segment four minutes later; requiring
      // every ADJACENT pair to arrive close together is what refuses that.
      record(args, withinBudget(`JD20-transcode-soak-longest-arrival-gap-seconds:${ref}`,
        Math.round(analysis.maxArrivalGapSeconds), MEDIA_SERVER_SOAK.MAX_SEGMENT_ARRIVAL_GAP_SECONDS,
        'the longest wall gap between two consecutive transcoded segments arriving, including the first'));
      record(args, atLeast(`JD20-transcode-soak-decoded-seconds:${ref}`,
        Math.floor(analysis.decodedMediaSeconds), seconds,
        'media time actually decoded out of the transcoded output, not segments counted'));
      // ...AND THE ONE THAT REFUSES A FRONT-LOADED RUN. Everything real happening early and the tail padded
      // out passes the span and the gap ceiling if the tail is thin enough; this says the end of the window
      // looks like the middle of it.
      record(args, atLeast(`JD20-transcode-soak-late-window-decoded-seconds:${ref}`,
        Math.floor(analysis.lateWindowDecodedSeconds),
        Math.floor(seconds * MEDIA_SERVER_SOAK.MIN_LATE_WINDOW_DECODED_FRACTION),
        'decoded h264 media time among the segments that arrived in the LAST THIRD of the window'));
      record(args, exactly(`JD20-transcode-soak-unprobed-segments:${ref}`, analysis.unprobed, 0,
        'every consumed segment was decoded, so the decoded total is not a sample'));
      record(args, exactly(`JD20-transcode-soak-distinct-segments:${ref}`,
        analysis.distinctSegments, analysis.segments,
        'every segment is a different segment: one window delivered fifty times is not fifty segments'));
      // THE ASSERTION THAT NOW CARRIES G10, AND IT IS ANCHORED AT BOTH ENDS INSIDE THIS PHASE.
      //
      // The source is asserted to be the codec the transcode was forced AWAY from, here rather than only in
      // the earlier short-transcode step: "every segment decoded as h264" says nothing at all if the source
      // was h264 to begin with, and a phase whose two halves live in different steps is a phase where one
      // half can quietly stop being true.
      // TAKEN FROM THE MEDIA SERVER'S OWN IDENTIFICATION OF THE ITEM, not from a flag the shell computed.
      // What matters is what the SERVER thought it was transcoding from, since it is the server's encoder
      // whose output is being decoded.
      const sourceCodec = itemFor(readItems(need(args, 'items')), key).videoCodec;
      record(args, {
        gate: `JD20-transcode-soak-source-codec:${ref}`,
        verdict: sourceCodec === TRANSCODE_SOURCE_VIDEO_CODEC ? 'pass' : 'fail',
        note: `the media server identified the source as ${sourceCodec || '(none)'}; a transcode to `
          + `${TRANSCODE_TARGET_VIDEO_CODEC} from a source that was already ${TRANSCODE_TARGET_VIDEO_CODEC} `
          + 'would prove nothing about an encoder',
      });
      record(args, exactly(`JD20-transcode-soak-wrong-codec:${ref}`, analysis.wrongCodec, 0,
        `the source is ${TRANSCODE_SOURCE_VIDEO_CODEC} throughout and every segment decoded as `
        + `${TRANSCODE_TARGET_VIDEO_CODEC}`));
      record(args, exactly(`JD20-transcode-soak-empty-segments:${ref}`, analysis.emptyOfVideo, 0));

      // TWO MEASUREMENTS THIS GATE RECORDS AND DELIBERATELY DOES NOT ASSERT ON, each with the measurement
      // that says why. Recording them is worth doing; asserting on them would be asserting something the
      // pinned server does not do, and then relaxing the threshold until it passed.
      //
      // THE ENCODER'S OWN OUTPUT SPAN. An earlier version of this gate required it to cover most of the
      // window, on the theory that a throttled encoder stays a bounded distance ahead of its client.
      // Measured, with throttling enabled: 115 output files written inside 1.6 seconds. The encoder finishes
      // a five-minute low-bitrate source almost immediately and exits. So this number is how far AHEAD OF
      // THE CLIENT it ran, and it is reported as that and nothing else.
      record(args, {
        gate: `JD20-transcode-soak-encoder-ahead-span-seconds:${ref}`,
        verdict: 'pass',
        measured: Math.round(analysis.encoderAheadSpanSeconds), budget: seconds,
        note: `${analysis.encoderOutputFiles} file(s) written by the transcoding job inside this window, `
          + 'spanning the seconds measured. RECORDED, NOT ASSERTED: the encoder races ahead of a paced client '
          + 'and exits, so this is how far ahead it ran and is NOT evidence that it was busy for five '
          + 'minutes. The five-minute claim rests on the continuity of decoded output above',
      });
      // AND THE OTHER HALF OF THE SAME LIMITATION, STATED WITH ITS NUMBER. Live `TranscodingInfo` disappears
      // when the encoder job ends, which on this source and host is within seconds; a share of it would be
      // an assertion about encoder liveness wearing a session's clothes.
      record(args, {
        gate: `JD20-transcode-soak-encoder-live-samples:${ref}`,
        verdict: 'pass',
        measured: analysis.encoderLiveSamples, budget: analysis.sessionSamples,
        note: 'samples in which the server was still reporting a LIVE transcoding job. RECORDED, NOT '
          + 'ASSERTED: it goes null once the encoder exits, which happens seconds into the window because '
          + 'the encoder finishes the whole source almost immediately. G10 is NOT closed as five minutes of '
          + 'encoder liveness by this gate',
      });
      // THE SESSION TELEMETRY, SAMPLED ACROSS THE WINDOW AND ASSERTED ON BY NOTHING.
      //
      // WHY NOTHING ASSERTS ON IT. An earlier version required `PlayState.PlayMethod` to read `Transcode` at
      // 80 % of samples — while the gate's own playback report was SENDING `PlayMethod: 'Transcode'`. That is
      // a claim this process made, handed to the server, and read back as evidence the server had produced.
      // A three-arm negative control against a live pinned server, with a real mpeg4 → h264 transcode
      // serving the segments in every arm, showed the field is client-writable: reporting `DirectPlay` made
      // the server record `DirectPlay` throughout. The gate now sends no `PlayMethod` at all, and this number
      // is telemetry. What carries the transcode claim is the decoded output above.
      // SAMPLES ARE SUCCESSFUL READS ONLY, and the failures beside them are gated at zero — otherwise a run
      // whose polls all failed satisfies "sampled across the window" with nothing but its own failures.
      record(args, exactly(`JD20-transcode-soak-failed-session-polls:${ref}`, raw.failedSessionPolls, 0,
        'session reads that never reached the server; a failed read is not an observation that the server '
        + 'reported nothing, and it may not be counted as one'));
      record(args, atLeast(`JD20-transcode-soak-session-samples:${ref}`, analysis.sessionSamples, 10,
        'successful session reads across the window, not one at the start'));
      // ...AND THE SAMPLES HAVE TO HAVE FOUND SOMETHING. A window in which this gate's own session was never
      // present is a window in which every number below describes an absence: `methodIsTranscode` and
      // `encoderJobLive` are both false for "no session of ours exists" and for "it exists and is neither",
      // and a count that cannot tell those apart is not telemetry, it is noise.
      record(args, atLeast(`JD20-transcode-soak-session-present-samples:${ref}`, analysis.sessionPresentSamples,
        Math.ceil(analysis.sessionSamples * MEDIA_SERVER_SOAK.MIN_SESSION_PRESENT_SAMPLE_FRACTION),
        `samples in which a session for THIS gate's device and this item existed at all, of `
        + `${analysis.sessionSamples} successful reads`));
      record(args, {
        gate: `JD20-transcode-soak-reported-method-samples:${ref}`,
        verdict: 'pass',
        measured: analysis.transcodeMethodSamples, budget: analysis.sessionSamples,
        note: 'samples in which the server reported this session\'s playback method as Transcode. RECORDED, '
          + 'NOT ASSERTED: a negative control showed the field is client-writable — a client reporting '
          + 'DirectPlay is recorded as DirectPlay while a real transcode serves it — so it is not the '
          + 'server\'s independent account. The gate authors no PlayMethod, and the transcode claim rests on '
          + 'the decoded mpeg4-to-h264 output above',
      });
      // AND WHETHER THE TELEMETRY ABOVE HAD A SUBJECT. A run whose playback reports were refused is a run
      // whose session numbers describe this gate's silence rather than the server's view, and that has to be
      // visible rather than swallowed — even for a number nothing asserts on.
      record(args, exactly(`JD20-transcode-soak-failed-playback-reports:${ref}`,
        raw.failedPlaybackReports, 0,
        'playback reports the server refused; a non-zero count makes the session telemetry beside it '
        + 'meaningless rather than merely low'));
      record(args, exactly(`JD20-transcode-soak-no-credential-in-generated-urls:${ref}`,
        raw.credentialsInGeneratedUrls, 0));
      return;
    }

    case 'hold-stream': {
      // A stream that is deliberately still in flight while the gate does something violent underneath it.
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const item = itemFor(items, key);
      const want = readExpected(need(args, 'expect-file')).find((entry) => entry.key === key);
      if (!want) fail(`no expectation was recorded for "${key}"`);
      const readyPath = need(args, 'ready');
      const releasePath = need(args, 'release');
      const allowInterrupt = args.flags.get('allow-interrupt') === 'true';
      const prefix = optionalNumber(args, 'prefix', 262_144);
      const ref = opaqueRef('entry', key).slice(0, 12);

      // ONE RESPONSE, OPENED ONCE. Not two ranged reads either side of the event — see `openPinnedStream`
      // for why that difference is the whole gate.
      const stream = await openPinnedStream(state, item);
      await stream.readAtLeast(prefix);
      const bytesBefore = stream.bytesRead;

      // THE STREAM MUST STILL HAVE SOMETHING LEFT TO DELIVER. If the body already ended, nothing is being
      // held open and every claim below would be about a completed download.
      record(args, {
        gate: `JD7-stream-open-at-event:${ref}`,
        verdict: !stream.ended && bytesBefore < want.sizeBytes ? 'pass' : 'fail',
        measured: bytesBefore, budget: want.sizeBytes,
        note: 'one response body, partially consumed and deliberately not drained',
      });

      mkdirSync(readyPath.replace(/[^/\\]*$/, '') || '.', { recursive: true });
      writeFileSync(readyPath, `${bytesBefore}\n`);
      console.log(`  the stream is live and unfinished: ${bytesBefore}/${want.sizeBytes} bytes consumed`);
      await awaitFile(releasePath, 'the gate to finish acting on the daemon',
        MEDIA_SERVER_DEADLINES_MS.HANDSHAKE);

      // Resume THE SAME reader and run it to the end. The digest is over everything this one response
      // delivered, first half and second.
      let outcome: 'completed' | 'interrupted' = 'completed';
      let detail = '';
      let result: { bytes: number; sha256: string } | undefined;
      try {
        result = await stream.finish();
      } catch (error) {
        outcome = 'interrupted';
        detail = (error as Error).message;
        await stream.cancel();
      }

      if (outcome === 'completed' && result !== undefined) {
        const correct = result.bytes === want.sizeBytes && result.sha256 === want.sha256;
        record(args, {
          gate: `JD7-open-stream-across-event:${ref}`,
          verdict: correct ? 'pass' : 'fail',
          measured: result.bytes, budget: want.sizeBytes,
          note: 'one held-open response delivered the whole file correctly across the event',
        });
        // ANTI-BUFFERING. If the body had already been buffered in full before the pause, nothing would have
        // arrived afterwards and "held open" would be a fiction. This measures the share that did.
        const after = result.bytes - bytesBefore;
        record(args, {
          gate: `JD7-bytes-after-event:${ref}`,
          verdict: after >= Math.floor(want.sizeBytes / 4) ? 'pass' : 'fail',
          measured: after, budget: Math.floor(want.sizeBytes / 4),
          note: 'bytes delivered by the same response AFTER the event, so the pause was real',
        });
      } else if (allowInterrupt) {
        // THE DOCUMENTED ALLOWED BEHAVIOUR, and only where the acceptance plan says it is: G12 says playback
        // is expected to fail across a SIGKILL and be resumable, and that the LIBRARY is not. Named for what
        // it is — an interruption — and deliberately NOT counted as open-handle pinning evidence.
        record(args, {
          gate: `JD7-open-stream-interrupted:${ref}`,
          verdict: 'pass',
          note: `the held-open stream failed, which the acceptance plan permits for this event. This is NOT `
            + `evidence of generation pinning; resumability is asserted separately by a new request. ${detail}`,
        });
      } else {
        record(args, { gate: `JD7-open-stream-across-event:${ref}`, verdict: 'fail', note: detail });
      }
      return;
    }

    case 'resume': {
      // After an interruption the item must be readable again, byte for byte, without a re-scan.
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const item = itemFor(items, key);
      const want = readExpected(need(args, 'expect-file')).find((entry) => entry.key === key);
      if (!want) fail(`no expectation was recorded for "${key}"`);
      const result = await directPlay(state, item, want.sizeBytes);
      record(args, {
        gate: `JD8-resume-after-recovery:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: result.bytes === want.sizeBytes && result.sha256 === want.sha256 ? 'pass' : 'fail',
        measured: result.bytes, budget: want.sizeBytes,
        note: 'playback is resumable and the bytes are still the published ones',
      });
      return;
    }

    case 'compare': {
      // Two item listings, and what changed between them. This is the churn gate, and it is the one the
      // acceptance plan is strictest about: a daemon crash must not make a library shrink.
      const before = readItems(need(args, 'before'));
      const after = readItems(need(args, 'after'));
      const gate = need(args, 'gate');
      const expectAdded = optionalNumber(args, 'expect-added', 0);

      const beforeKeys = new Set(before.map((item) => item.key));
      const afterKeys = new Set(after.map((item) => item.key));
      const added = [...afterKeys].filter((key) => !beforeKeys.has(key));
      const removed = [...beforeKeys].filter((key) => !afterKeys.has(key));

      record(args, exactly(`${gate}-removed`, removed.length, 0,
        'a re-scan removing an item is the failure this appliance exists to avoid'));
      record(args, exactly(`${gate}-added`, added.length, expectAdded));

      // Duplicates: two items for one file is the other shape of churn, and a set comparison hides it.
      const counts = new Map<string, number>();
      for (const item of after) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
      const duplicated = [...counts.values()].filter((count) => count > 1).length;
      record(args, exactly(`${gate}-duplicates`, duplicated, 0));

      // IDENTITY, not just presence. A media server that re-created an item under a new id has lost every
      // piece of watch state attached to it, and a count comparison would call that a clean re-scan.
      let churned = 0;
      for (const item of before) {
        if (!afterKeys.has(item.key)) continue;
        const now = after.find((entry) => entry.key === item.key) as ItemRecord;
        if (now.itemId !== item.itemId) churned += 1;
      }
      record(args, exactly(`${gate}-item-id-churn`, churned, 0,
        'carried items keep the id they were first given'));

      // And the metadata the server derived from the file has not moved either.
      let moved = 0;
      for (const item of before) {
        const now = after.find((entry) => entry.key === item.key);
        if (now && (now.sizeBytes !== item.sizeBytes || now.container !== item.container)) moved += 1;
      }
      record(args, exactly(`${gate}-metadata-drift`, moved, 0));
      return;
    }

    case 'counters': {
      const url = need(args, 'url');
      // A ref'd watchdog, for the same reason every other request in this gate has one: `AbortSignal.timeout`
      // does not keep the event loop alive, and a provider that accepted the connection without answering
      // would let this process exit 0 having read nothing.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (!response.ok) fail(`the provider counters endpoint answered ${response.status}`);
      const snapshot = await response.json() as Record<string, number>;
      writeFileSync(need(args, 'out'), `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(`  provider counters: ${JSON.stringify(snapshot)}`);
      return;
    }

    case 'budget': {
      // What the media server's own behaviour cost at the provider, between two counter snapshots.
      const before = JSON.parse(readFileSync(need(args, 'before'), 'utf8')) as Record<string, number>;
      const after = JSON.parse(readFileSync(need(args, 'after'), 'utf8')) as Record<string, number>;
      const gate = need(args, 'gate');
      const entries = optionalNumber(args, 'entries', 1);
      const remoteBytes = optionalNumber(args, 'bytes', 1);
      const windows = optionalNumber(args, 'windows', MEDIA_SERVER_BUDGETS.MAX_SCAN_RANGE_MULTIPLIER);
      const delta = (key: string): number => (after[key] ?? 0) - (before[key] ?? 0);

      record(args, withinBudget(`${gate}-range-requests`, delta('rangeRequests'),
        Math.ceil(entries * windows), `denominator: ${entries} remote entries x ${windows} windows`));
      record(args, withinBudget(`${gate}-resolutions`, delta('resolutions'),
        Math.ceil(entries * MEDIA_SERVER_BUDGETS.MAX_SCAN_RESOLUTION_MULTIPLIER),
        `denominator: ${entries} remote entries`));
      // THE ONE THAT MATTERS. A scanner that downloaded the file to identify it would sit at or above 1.0 of
      // the object's own length; the budget is a fraction of it, so "it works, it just fetches everything"
      // cannot pass.
      //
      // TWO DENOMINATORS WHEN THERE ARE TWO KINDS OF OBJECT, AND THE SECOND ONE IS ABOVE 1.0 ON PURPOSE.
      // Below the contract's single-probe threshold an entry's own probe window IS the whole object, so
      // identifying it costs its whole length by construction and a sub-1.0 budget over it would be a gate
      // that could never pass. Folding the two together would be worse than either: the large entries would
      // pay for the small ones, and a regression in the large path — the one the product's argument rests
      // on — would disappear into the average. So each names its own denominator, and both are printed.
      const smallBytes = optionalNumber(args, 'small-bytes', 0);
      const byteBudget = Math.floor(remoteBytes * MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION
        + smallBytes * MEDIA_SERVER_BUDGETS.MAX_SMALL_OBJECT_SCAN_BYTE_MULTIPLIER);
      record(args, withinBudget(`${gate}-provider-bytes`, delta('bytesServed'), byteBudget,
        `denominators: ${remoteBytes} bytes in objects above the single-probe threshold at `
        + `x${MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION}, and ${smallBytes} bytes below it at `
        + `x${MEDIA_SERVER_BUDGETS.MAX_SMALL_OBJECT_SCAN_BYTE_MULTIPLIER}`));
      record(args, withinBudget(`${gate}-http-429`, delta('served429'), MEDIA_SERVER_BUDGETS.MAX_HTTP_429));
      record(args, withinBudget(`${gate}-full-body-on-range`, delta('fullBodyServed'),
        MEDIA_SERVER_BUDGETS.MAX_FULL_BODY_SERVED));
      record(args, withinBudget(`${gate}-peak-connections`, after.peakConns ?? 0,
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS));
      // A FLOOR, where the caller knows the scan had to reach the provider at all. Without it, a scan that
      // never opened the remote entry would score a perfect zero against every ceiling above.
      const floor = args.flags.get('min-range');
      if (floor !== undefined) {
        record(args, atLeast(`${gate}-range-requests-floor`, delta('rangeRequests'), Number(floor),
          'a scan that reached the provider zero times did not read the entry'));
      }
      return;
    }

    case 'traffic-window': {
      // WHAT A FIVE-MINUTE READ COST AT THE PROVIDER, bounded explicitly rather than by a scan multiplier.
      //
      // WHY THE SCAN BUDGETS DO NOT APPLY HERE. `budget` measures a metadata pass, whose whole argument is
      // that it reads a fraction of the object. A five-minute PLAYBACK legitimately reads the object — that
      // is what playing it means — so a fraction budget over it would be a gate that could not pass, and
      // leaving the window unmeasured would be a gate that could not fail. What is bounded instead is
      // AMPLIFICATION: how many times over the daemon fetched an object it was streaming once.
      const before = JSON.parse(readFileSync(need(args, 'before'), 'utf8')) as Record<string, number>;
      const after = JSON.parse(readFileSync(need(args, 'after'), 'utf8')) as Record<string, number>;
      const gate = need(args, 'gate');
      const objectBytes = optionalNumber(args, 'object-bytes', 1);
      const multiplier = optionalNumber(args, 'max-object-multiplier', 3);
      const delta = (key: string): number => (after[key] ?? 0) - (before[key] ?? 0);

      record(args, withinBudget(`${gate}-provider-bytes`, delta('bytesServed'),
        Math.floor(objectBytes * multiplier),
        `denominator: the object's own ${objectBytes} bytes, read at most ${multiplier}x over the window`));
      record(args, withinBudget(`${gate}-range-requests`, delta('rangeRequests'),
        optionalNumber(args, 'max-range-requests', 4096),
        'a ranged read per window the daemon needed, and a ceiling a runaway read-ahead would blow'));
      // A FLOOR AS WELL, because a window in which the provider was never reached would score perfectly
      // against every ceiling above and would mean the entry was served from somewhere else entirely.
      // A WARM WINDOW IS NOT A FAILURE, AND IT IS NOT A FREE PASS EITHER. See `readWarmCacheEvidence` for the
      // unconditional floor this replaces and the daemon repair that invalidated it.
      const providerRequests = delta('rangeRequests');
      if (providerRequests > 0) {
        // COLD, AND UNCHANGED. The window reached the provider, so the original floor is exactly right and is
        // asserted under its original name. Nothing about a cold run's verdicts moves.
        record(args, atLeast(`${gate}-range-requests-floor`, providerRequests,
          optionalNumber(args, 'min-range-requests', 1),
          'a window in which the provider was never reached means the bytes came from somewhere else'));
      } else if (providerRequests < 0) {
        // A PROVIDER COUNTER THAT FELL IS A BROKEN INSTRUMENT, NOT A WARM WINDOW: the endpoint restarted or
        // its counters were reset between the two readings, so the window describes no interval at all and
        // neither a ceiling nor a warm claim can be made about it. The warm arm is reached on EXACTLY zero.
        record(args, {
          gate: `${gate}-provider-counters-coherent`, verdict: 'fail',
          measured: providerRequests, budget: 0,
          note: 'the provider\'s request counter FELL across this window, which happens only when the '
            + 'endpoint restarted or its counters were reset between the two readings. The window describes '
            + 'no interval, so neither a ceiling nor a warm-cache claim can be made about it',
        });
      } else {
        const warm = readWarmCacheEvidence(args);
        record(args, {
          gate: `${gate}-warm-daemon-counters-coherent`,
          verdict: warm.coherent ? 'pass' : 'fail',
          measured: warm.present ? 1 : 0, budget: 1,
          note: warm.coherenceNote,
        });
        record(args, atLeast(`${gate}-warm-daemon-cache-hits`, warm.hits, 1,
          'the daemon\'s own playback cache answered this many reads over exactly this window; zero means '
          + 'the bytes did not come from this daemon\'s memory and the window proves nothing'));
        record(args, atLeast(`${gate}-warm-daemon-cache-hit-bytes`, warm.hitBytes, 1,
          'and served this many bytes doing it. A hit COUNT alone cannot separate a window served from '
          + 'memory from one that hit once on a trivial read'));
        // THE HEADLINE, NAMED FOR THE ASSERTION IT REPLACES so a reader of two runs sees the substitution
        // rather than a floor that silently vanished.
        const served = warm.coherent && warm.hits > 0 && warm.hitBytes > 0;
        record(args, {
          gate: `${gate}-range-requests-warm-capable`,
          verdict: served ? 'pass' : 'fail',
          measured: providerRequests, budget: 0,
          note: served
            ? 'this window never reached the provider, and the daemon\'s playback cache is what served it: '
              + `${warm.hits} hits, ${warm.hitBytes} bytes, over exactly this window. Warm reuse across `
              + 'opens is the intended behaviour, not a bypass'
            : 'this window never reached the provider AND the daemon\'s playback cache cannot account for '
              + `it (${warm.coherenceNote}). Zero provider traffic with no daemon cache evidence is what a `
              + 'stale mount, a bypassed daemon or a read that never happened also look like',
        });
      }
      record(args, withinBudget(`${gate}-http-429`, delta('served429'), MEDIA_SERVER_BUDGETS.MAX_HTTP_429));
      record(args, withinBudget(`${gate}-full-body-on-range`, delta('fullBodyServed'),
        MEDIA_SERVER_BUDGETS.MAX_FULL_BODY_SERVED));
      record(args, withinBudget(`${gate}-peak-connections`, after.peakConns ?? 0,
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS));
      return;
    }

    case 'assert-scan-in-flight': {
      // THE PRE-PUBLISH GUARD. The marker says the scan WAS running when another process looked; this asks
      // whether it still is, at the last possible moment before the successor is published. A `sleep` here
      // would be the very thing the mid-scan finding was about, so this is a fresh observation or nothing.
      const state = readState(need(args, 'state'));
      const running = await scanIsRunningNow(state);
      if (!running) {
        fail('the scan is no longer running, so a publish now would not be a mid-scan publish. '
          + 'Refusing rather than publishing and claiming otherwise.');
      }
      console.log('  the scanner is still in flight at the moment of publication');
      return;
    }

    case 'provider-invariants': {
      // ABSOLUTE, NOT A DELTA. These three are zero (or under a cap) for the WHOLE run, not merely across
      // some window of it. A delta check would let a 429 that happened during direct play cancel out against
      // a window that did not include it, and "the admission limits held during the scan" is a much weaker
      // claim than "they never stopped holding".
      const snapshot = JSON.parse(readFileSync(need(args, 'counters'), 'utf8')) as Record<string, number>;
      const gate = need(args, 'gate');
      record(args, withinBudget(`${gate}-http-429-total`, snapshot.served429 ?? 0,
        MEDIA_SERVER_BUDGETS.MAX_HTTP_429, 'across the whole run'));
      record(args, withinBudget(`${gate}-full-body-total`, snapshot.fullBodyServed ?? 0,
        MEDIA_SERVER_BUDGETS.MAX_FULL_BODY_SERVED, 'across the whole run'));
      record(args, withinBudget(`${gate}-peak-connections-total`, snapshot.peakConns ?? 0,
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS, 'across the whole run'));
      record(args, withinBudget(`${gate}-peak-concurrent-reads`, snapshot.peakConcurrent ?? 0,
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS, 'across the whole run'));
      return;
    }

    case 'report': {
      const results = readResults(need(args, 'results'));
      if (results.length === 0) fail('there are no results to report, which is itself a failure');
      const failed = results.filter((result) => result.verdict === 'fail');
      const skipped = results.filter((result) => result.verdict === 'skip');

      // THE REDACTION RULE IS APPLIED TO THE REPORT BEFORE IT IS PRINTED, not promised in a comment.
      const problems = findRedactionProblems(results);
      if (problems.length > 0) {
        console.error('the gate report would have leaked:');
        for (const problem of problems.slice(0, 20)) console.error(`  ${problem.kind} at ${problem.at}`);
        fail('the report is not redaction-safe');
      }

      console.log('');
      console.log(`Projection Phase 1 — media-server data plane: ${results.length} assertions, `
        + `${failed.length} failed, ${skipped.length} skipped.`);
      for (const result of results) {
        const measured = result.measured === undefined ? '' : ` ${result.measured}/${result.budget}`;
        console.log(`  ${result.verdict.padEnd(4)} ${result.gate}${measured}`);
      }
      const jsonOut = args.flags.get('json');
      if (jsonOut !== undefined) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
      if (failed.length > 0) process.exit(1);
      return;
    }

    case 'redaction-check': {
      // Any file the gate is about to keep, checked against the same rule the report is.
      const path = need(args, 'file');
      if (!existsSync(path)) fail(`${path.split(/[/\\]/).pop()} does not exist`);
      const problems = findRedactionProblems(JSON.parse(readFileSync(path, 'utf8')));
      if (problems.length > 0) {
        for (const problem of problems.slice(0, 20)) console.error(`  ${problem.kind} at ${problem.at}`);
        fail('a kept artifact is not redaction-safe');
      }
      console.log('  redaction-safe');
      return;
    }

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

// A PHASE THAT ENDS WITHOUT SAYING SO IS A FAILURE, NOT A PASS.
//
// This is the second half of the fix described on `request`. That one removes the cause; this one removes the
// SYMPTOM'S ability to look like success. The keepalive holds the event loop open for as long as a phase is
// running, so an idle await cannot let Node exit; and the flag makes an exit that happens anyway — for any
// reason at all — carry a non-zero status and a message, instead of an empty stdout and a 0 the caller reads
// as "that phase passed".
let finished = false;
const keepalive = setInterval(() => undefined, 1_000);
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('projection-jellyfin-dataplane: the phase exited without completing');
    process.exitCode = 1;
  }
});

main()
  .then(() => { finished = true; })
  .catch((error: unknown) => {
    finished = true;
    if (error instanceof GateFailure) fail(error.message);
    fail(`${(error as Error).message}\n${(error as Error).stack ?? ''}`);
  })
  .finally(() => { clearInterval(keepalive); });
