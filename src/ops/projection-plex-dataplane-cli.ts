import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MEDIA_SERVER_BUDGETS, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_SOAK, SEEK_PLAN_FRACTIONS,
  TRANSCODE_SOURCE_VIDEO_CODEC, TRANSCODE_TARGET_VIDEO_CODEC, analysePacedPlayback, analyseSeekSet,
  analyseTranscodeSoak, atLeast, corpusProblems, corpusSelfProblems, exactly, findRedactionProblems,
  opaqueRef, providerByteResults, seekPlanProblems, seekPositionsFor, withinBudget,
  type GateResult, type SeekDecode, type SoakProbe,
} from '../core/projection/media-server-dataplane.js';
import {
  PLEX_ENCODER_FLOORS, PLEX_GATE6_COMPATIBLE_BLOCKS, PLEX_LARGE_FIXTURE, PLEX_READ_GEOMETRY,
  PLEX_SCAN_ENVELOPE, analysePlexEncoderLiveness, plexHighestMeasuredPerEntry,
  plexInstrumentedWindowCounts, plexObjectByteCeiling, plexScanByteCeiling, plexScanRequestCeilings,
  plexSeekByteCeiling,
} from '../core/projection/plex-dataplane.js';
import {
  GateFailure, addMovieLibrary, appendResult, applyPreferences, assertAnonymousLocalApi, awaitFile,
  awaitServer, directPlay, forcedTranscode, isOrdinaryFile, listMovies, mediaTimeSeekSet, openPinnedStream,
  pacedDirectPlay, rangeRead, readExpected, readProducerFiles, readResults, readState, resolveSectionId,
  safePartPath, scanBaseline, scanIsRunningNow, scanLibrary, transcodeSoak, writeState,
  type GateState, type ItemRecord,
} from './projection-plex-dataplane.js';

// The Projection Phase 1 PLEX data-plane gate, from the command line.
//
// IT IS A SEQUENCE OF PHASES RATHER THAN ONE RUN, for the same reason the Jellyfin one is: three of the gates
// are about what happens to a media server WHILE something is done to the daemon underneath it — a successor
// published mid-stream, a SIGKILL mid-playback, a generation admitted mid-scan — and the something is a
// publisher command and a `docker kill`. A single self-contained run would have had to learn to drive Docker
// and PostgreSQL, and the interesting half of the gate would be a mock of the shell script it replaced.
//
// THE DECODING IS NOT IN HERE, ON PURPOSE, AND ON PLEX IT IS STRUCTURALLY IMPOSSIBLE FOR IT TO BE. Every
// "playable video" claim this gate makes is made by a real decoder in a separate container, over files these
// phases wrote; the `*-verify` phases hold that decoder's answers against the acceptance plan. On Jellyfin
// that separation is a discipline — the server ships a full ffmpeg and the gate could have used it. The Plex
// image ships only `Plex Transcoder`, an ffmpeg fork with no ffprobe at all, so the decoder is necessarily
// third-party software with no relationship to the server that produced the bytes.
//
//   bootstrap     --state F --base URL
//   prefs         --state F
//   library       --state F --mount-path P --name N
//   scan          --state F --expect-file F --out F [--label L] [--tolerant true] [--running-marker F]
//   corpus-check  --expect-file F --min-entries N --min-remote N
//   play          --state F --items F --key K --expect-file F
//   seek          --state F --items F --key K --offset N --length N --expect-sha H
//   transcode     --state F --items F --key K --out-segment F [--max-segments N]
//   transcode-verify --key K --codec C --packets N --source-codec C
//   hold-stream   --state F --items F --key K --expect-file F --ready F --release F [--allow-interrupt true]
//   resume        --state F --items F --key K --expect-file F
//   compare       --before F --after F --gate G [--expect-added N]
//   counters      --url U --out F
//   budget        --before F --after F --gate G --entries N --object-sizes N,N,... [--windows N]
//   traffic-window --before F --after F --gate G --object-bytes N [--max-object-multiplier N]
//   assert-scan-in-flight --state F
//   provider-invariants --counters F --gate G
//   paced-play    --state F --items F --key K --image I --network N --container-name C --work-dir D
//                 --stream-base U --output-rel P --ffmpeg P --trace F [--seconds N]
//   paced-play-output --probed-seconds N --probed-packets N [--seconds N]
//   media-seeks   --state F --items F --key K --duration-seconds N --segment-dir D --out F
//   seek-verify   --key K --seeks F --probes F
//   transcode-soak        --state F --items F --key K --segment-dir D --out F [--seconds N]
//   transcode-soak-verify --key K --items F --soak F --probes F [--seconds N]
//   redaction-check --file F
//   report        --results F [--json F]

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
  console.error(`projection-plex-dataplane: ${message}`);
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
 * A COUNTERS SNAPSHOT AS IT ACTUALLY IS, WHICH IS NOT A MAP OF NUMBERS.
 *
 * THE DEFECT THIS CLOSES. Every phase read the endpoint's JSON `as Record<string, number>`. That was a lie
 * the moment per-object attribution arrived: two of the fields are ARRAYS, and a cast does not make them
 * scalars. TypeScript then cheerfully typed `snapshot.objectBytes` as a number and every arithmetic on it
 * as valid, which is precisely the checking the cast was pretending to provide.
 *
 * The honest type says the values are unknown, and `counterValue` is the only way a scalar comes out of one.
 */
type ProviderCounterSnapshot = Record<string, unknown>;

/**
 * Reads one SCALAR counter, and refuses anything that is not a whole non-negative count.
 *
 * A MISSING COUNTER IS ZERO, DELIBERATELY, because the endpoint omits nothing it tracks and older artifacts
 * legitimately lack fields added later. A PRESENT counter that is not a number is a broken instrument, and
 * it is rejected HERE rather than left to the arithmetic.
 *
 * NOT BECAUSE IT WOULD PASS — AN EARLIER VERSION OF THIS COMMENT SAID SO AND WAS WRONG. Every comparison
 * against NaN is false, and the helpers read `measured <= budget`, `measured >= floor` and
 * `measured === expected` with pass on the true branch, so NaN makes each of them FAIL. The reason to
 * validate is that those failures are meaningless: a gate reporting "PX9b-provider-bytes NaN/48222708"
 * blames the data plane for a broken counters file, and an operator would spend the investigation in the
 * wrong place. Corrupt instrumentation should say it is corrupt, by name, at the point it is read.
 */
function counterValue(snapshot: ProviderCounterSnapshot, key: string): number {
  const raw = snapshot[key];
  if (raw === undefined) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    fail(`the counter ${key} is ${JSON.stringify(raw)}, which is not a whole non-negative count. Every `
      + 'budget reading it would fail against NaN and blame the data plane for a broken counters file');
  }
  return raw as number;
}

/**
 * What the DAEMON's own playback cache did over a window, read from two `/readyz` documents.
 *
 * WHY THIS EXISTS AT ALL. Since a handle release stopped deleting playback entries, a window of real playback
 * can legitimately reach the provider zero times. "Zero provider requests" then has two explanations that
 * demand opposite responses — the daemon served it from memory, or the daemon was not what served it — and
 * the provider's counters cannot tell them apart, because the distinguishing evidence is on the other side.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS NOT PEDANTRY.
 *   ABSENT SNAPSHOTS. A caller that measured no daemon evidence has proved nothing about a zero window; it
 *   must not be quietly the same as one that measured evidence and found it.
 *   A MISSING `playback` OBJECT. A daemon too old to publish these counters reads as all-zero through a
 *   forgiving parser, which is indistinguishable from a daemon that served nothing. It is named as absent.
 *   A NEGATIVE DELTA. Cumulative counters only rise within one process. A drop means the daemon RESTARTED
 *   inside the window, so the "after" reading describes a different process's cache and subtracting the two
 *   produces a number about nothing. This is the one failure mode a warm-cache claim is most exposed to,
 *   because the gate restarts the daemon on purpose elsewhere in the same run.
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
  const measured = result.measured === undefined ? '' : ` (${result.measured}/${result.budget})`;
  console.log(`  ${result.verdict.toUpperCase()} ${result.gate}${measured}`);
  if (result.note !== undefined) console.log(`       ${result.note}`);
}

/** A short, stable, non-identifying handle for an item, safe to put in a report. */
function ref(item: ItemRecord): string {
  return opaqueRef('entry', item.key).slice(0, 12);
}

/** One transcode session id per phase, derived from the phase name so two runs are comparable. */
function sessionId(phase: string): string {
  return `projection-gate-${phase}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'bootstrap': {
      // NO WIZARD, NO ACCOUNT, NO CLAIM TOKEN. An unclaimed Plex answers a local request with no credential,
      // which is what lets this gate run against a real Plex without anybody's personal credentials — and
      // `claimed` is asserted rather than assumed. What counts as local is decided by the `Host` header, not
      // by the peer address; see `PLEX_REJECTS_UNRECOGNISED_HOST_HEADER`.
      const state: GateState = { baseUrl: need(args, 'base') };
      const outcome = await awaitServer(state);
      await assertAnonymousLocalApi(state);
      state.machineIdentifier = outcome.machineIdentifier;
      state.serverVersion = outcome.version;
      const existing = args.flags.get('name');
      if (existing !== undefined) {
        state.sectionId = await resolveSectionId(state, existing);
        state.sectionName = existing;
      }
      writeState(need(args, 'state'), state);
      record(args, {
        gate: 'PX1-server-unclaimed', verdict: outcome.claimed ? 'fail' : 'pass',
        note: 'the server is not tied to any Plex account, so this run needs nobody\'s credentials',
      });
      record(args, {
        gate: 'PX1-anonymous-local-api', verdict: 'pass',
        note: 'the local API answered without a credential, which is how an unclaimed server behaves',
      });
      return;
    }

    case 'prefs': {
      const state = readState(need(args, 'state'));
      const applied = await applyPreferences(state);
      record(args, {
        gate: 'PX1-preferences-applied', verdict: 'pass', measured: applied, budget: applied,
        note: 'every one read back and compared; PUT /:/prefs answers 200 for a name it does not know',
      });
      return;
    }

    case 'library': {
      const statePath = need(args, 'state');
      const state = readState(statePath);
      await addMovieLibrary(state, need(args, 'mount-path'), need(args, 'name'));
      writeState(statePath, state);
      record(args, {
        gate: 'PX2-library-at-mount', verdict: 'pass',
        note: 'the library root is the projected mount, with the personal-media agent asserted',
      });
      return;
    }

    case 'scan': {
      const statePath = need(args, 'state');
      const state = readState(statePath);
      const expected = readExpected(need(args, 'expect-file'));
      // THE SYNCHRONISATION POINT FOR THE MID-SCAN GATE. Written the moment the scanner is observed IN
      // FLIGHT, so the publishing half waits on an observation rather than on a sleep.
      const runningMarker = args.flags.get('running-marker');
      const outcome = await scanLibrary(state, runningMarker === undefined ? undefined : () => {
        mkdirSync(runningMarker.replace(/[^/\\]*$/, '') || '.', { recursive: true });
        writeFileSync(runningMarker, 'running\n');
      });
      writeState(statePath, state);
      writeFileSync(need(args, 'out'), `${JSON.stringify(outcome.items, null, 2)}\n`);
      const label = args.flags.get('label') ?? 'scan';
      const items = outcome.items;
      const seconds = Math.round(outcome.seconds);

      // A TOLERANT SCAN IS ONE THE GATE DELIBERATELY RACED. When a successor is published WHILE a scan runs,
      // the scan may legitimately have seen the predecessor's namespace, the successor's, or a mixture.
      // Asserting a count against any of them would be asserting the outcome of a race; what must hold is
      // checked by the STRICT scan that follows.
      if (args.flags.get('tolerant') === 'true') {
        record(args, {
          gate: `PX3-${label}-scan-observed-in-flight`,
          verdict: outcome.observedInFlight ? 'pass' : 'fail',
          note: 'the scanner was seen actually running; a fast complete between polls does not count',
        });
        record(args, {
          gate: `PX3-${label}-raced-scan-completed`, verdict: 'pass',
          note: `a scan raced against a publish settled in ${seconds}s and returned ${items.length} items; `
            + 'what it saw is recorded, not asserted, and the next scan is the one that must converge',
        });
        for (const item of items) {
          record(args, {
            gate: `PX3-${label}-raced-item-coherent:${ref(item)}`,
            verdict: item.sizeBytes > 0 && isOrdinaryFile(item) ? 'pass' : 'fail',
            note: 'a mid-scan generation change must not produce a half-formed item',
          });
        }
        return;
      }

      record(args, exactly(`PX3-${label}-item-count`, items.length, expected.length,
        `the scan settled in ${seconds}s`));

      // THE WHOLE CORPUS IN ONE PASS, AS A COUNT OF MATCHED IDENTITIES rather than a count of items. A
      // listing of fifty arbitrary files has the right length; `matched` only counts a PUBLISHED key that
      // was present, at the published size, as an ordinary file.
      const problems = corpusProblems(expected, items.map((item) => ({
        key: item.key,
        sizeBytes: item.sizeBytes,
        ordinaryFile: isOrdinaryFile(item),
      })));
      record(args, exactly(`PX3-${label}-corpus-matched`, problems.matched, expected.length,
        'published identities catalogued at the published size, with the server\'s own live '
        + 'accessible/exists answer through the mount'));
      record(args, exactly(`PX3-${label}-corpus-missing`, problems.missing, 0));
      record(args, exactly(`PX3-${label}-corpus-wrong-size`, problems.wrongSize, 0));
      record(args, exactly(`PX3-${label}-corpus-not-ordinary`, problems.notOrdinary, 0,
        'accessible and exists both true from checkFiles=1, a real container, not a .strm placeholder'));
      record(args, exactly(`PX3-${label}-corpus-duplicated`, problems.duplicated, 0));
      record(args, exactly(`PX3-${label}-corpus-unexpected`, problems.unexpected, 0));

      // AND NOTHING WAS MATCHED AGAINST AN ONLINE CATALOGUE. The personal-media agent gives every item a
      // `tv.plex.agents.none://` guid. A `plex://movie/...` guid would mean the section had been created or
      // migrated to the online agent, and every identity assertion in this run would then be measuring
      // somebody else's metadata service.
      const onlineGuids = items.filter((item) => !item.guid.startsWith('tv.plex.agents.none://')).length;
      record(args, exactly(`PX3-${label}-offline-identities`, onlineGuids, 0,
        'every item identified by the personal-media agent, so no identity depends on plex.tv'));
      return;
    }

    case 'corpus-check': {
      // THE CORPUS IS CHECKED AGAINST ITSELF BEFORE A MEDIA SERVER IS INVOLVED. Two byte-identical entries
      // would make every digest comparison in this gate decorative, because a read that returned the wrong
      // entry would still match.
      const expected = readExpected(need(args, 'expect-file'));
      const problems = corpusSelfProblems(expected);
      for (const problem of problems) console.error(`  ${problem}`);
      record(args, exactly('PX0-corpus-self-consistent', problems.length, 0));
      record(args, atLeast('PX0-corpus-entries', expected.length, optionalNumber(args, 'min-entries', 50)));
      record(args, atLeast('PX0-corpus-remote-entries',
        expected.filter((entry) => entry.kind === 'http-range').length,
        optionalNumber(args, 'min-remote', 30),
        'the corpus is mostly served over HTTP Range, so a scan of it is a provider measurement'));
      if (problems.length > 0) fail('the corpus is not fit to be evidence');
      return;
    }

    case 'play': {
      // DIRECT PLAY, BYTE FOR BYTE, against a digest recorded OUTSIDE the mount. A hash taken through the
      // thing being verified only proves a file hashes to itself.
      const state = readState(need(args, 'state'));
      const item = itemFor(readItems(need(args, 'items')), need(args, 'key'));
      const expected = readExpected(need(args, 'expect-file')).find((entry) => entry.key === item.key);
      if (expected === undefined) throw new GateFailure('nothing was published under that name');
      const { hadCredential } = safePartPath(item);
      const result = await directPlay(state, item, expected.sizeBytes);
      record(args, exactly(`PX4-direct-play-bytes:${ref(item)}`, result.bytes, expected.sizeBytes));
      record(args, {
        gate: `PX4-direct-play-digest:${ref(item)}`,
        verdict: result.sha256 === expected.sha256 ? 'pass' : 'fail',
        note: 'compared against the digest recorded outside the mount before anything was published',
      });
      record(args, exactly(`PX4-no-credential-in-part-url:${ref(item)}`, hadCredential ? 1 : 0, 0,
        'the server generated the part URL; this gate authors no token and must have none to strip'));
      return;
    }

    case 'seek': {
      // A REAL HTTP SEEK. The 206 and the exact Content-Range are asserted inside `rangeRead`, BEFORE the
      // body is read, because a 200-with-the-whole-file would otherwise pass as a successful seek.
      const state = readState(need(args, 'state'));
      const item = itemFor(readItems(need(args, 'items')), need(args, 'key'));
      const offset = optionalNumber(args, 'offset', 0);
      const length = optionalNumber(args, 'length', 131_072);
      const result = await rangeRead(state, item, offset, length);
      record(args, exactly(`PX5-range-status:${ref(item)}`, result.status, 206));
      record(args, exactly(`PX5-range-bytes:${ref(item)}`, result.bytes, length));
      record(args, {
        gate: `PX5-range-digest:${ref(item)}`,
        verdict: result.sha256 === need(args, 'expect-sha') ? 'pass' : 'fail',
        note: 'the window hashed on the host, against the window the media server returned',
      });
      return;
    }

    case 'transcode': {
      const state = readState(need(args, 'state'));
      const item = itemFor(readItems(need(args, 'items')), need(args, 'key'));
      const outcome = await forcedTranscode(state, item, sessionId('transcode'),
        need(args, 'out-segment'), Math.trunc(optionalNumber(args, 'max-segments', 2)));
      record(args, atLeast(`PX6-transcode-segments:${ref(item)}`, outcome.segments, 1));
      record(args, atLeast(`PX6-transcode-bytes:${ref(item)}`, outcome.bytes, 1));
      record(args, exactly(`PX6-no-credential-in-generated-urls:${ref(item)}`,
        outcome.credentialsInGeneratedUrls, 0,
        'Plex generates child URLs in the shape of the request; this gate authors no token'));
      // RECORDED, NOT ASSERTED. The server's own decision for the job is server-authored — Plex has no
      // client-writable play-method field — but this gate's transcode claim rests on the decoded output, and
      // the decoding happens in another container. See `transcode-verify`.
      record(args, {
        gate: `PX6-server-decision-recorded:${ref(item)}`, verdict: 'pass',
        note: `the server said decision=${outcome.sample.videoDecision ?? 'none'} `
          + `source=${outcome.sample.sourceVideoCodec ?? 'none'} out=${outcome.sample.videoCodec ?? 'none'}; `
          + 'recorded as telemetry, asserted by nothing',
      });
      return;
    }

    case 'transcode-verify': {
      // THE ASSERTION, MADE OVER A DECODER'S ANSWER RATHER THAN THE SERVER'S. The decoder ran in another
      // container, over the file the phase above wrote, and knows nothing about Plex.
      const key = need(args, 'key');
      record(args, {
        gate: `PX6-source-codec:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: need(args, 'source-codec') === TRANSCODE_SOURCE_VIDEO_CODEC ? 'pass' : 'fail',
        note: `the source is ${need(args, 'source-codec')}; a "transcode to h264" from an h264 source `
          + 'would prove nothing',
      });
      record(args, {
        gate: `PX6-output-codec:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: need(args, 'codec') === TRANSCODE_TARGET_VIDEO_CODEC ? 'pass' : 'fail',
        note: `an independent decoder says the output is ${need(args, 'codec')}`,
      });
      record(args, atLeast(`PX6-output-packets:${opaqueRef('entry', key).slice(0, 12)}`,
        optionalNumber(args, 'packets', 0), 1, 'decodable video packets, not merely a non-empty file'));
      return;
    }

    case 'hold-stream': {
      // ONE RESPONSE BODY, held open across an event, read in two halves from the SAME reader. Two
      // sequential requests either side of a swap are a different and much weaker claim.
      const state = readState(need(args, 'state'));
      const item = itemFor(readItems(need(args, 'items')), need(args, 'key'));
      const expected = readExpected(need(args, 'expect-file')).find((entry) => entry.key === item.key);
      if (expected === undefined) throw new GateFailure('nothing was published under that name');
      const allowInterrupt = args.flags.get('allow-interrupt') === 'true';
      const prefix = Math.max(65_536, Math.floor(expected.sizeBytes / 4));

      const stream = await openPinnedStream(state, item);
      await stream.readAtLeast(prefix);
      const bytesBefore = stream.bytesRead;
      if (stream.ended) {
        throw new GateFailure('the whole body arrived before the event, so nothing was held open');
      }
      writeFileSync(need(args, 'ready'), `${bytesBefore}\n`);
      await awaitFile(need(args, 'release'), 'the other half of the gate to finish its event',
        MEDIA_SERVER_DEADLINES_MS.HANDSHAKE);

      let result;
      try {
        result = await stream.finish();
      } catch (error) {
        if (!allowInterrupt) throw error;
        // A HELD-OPEN STREAM IS PERMITTED TO DIE ACROSS A SIGKILL, and this is recorded under its own gate
        // id so it can never be read as generation-pinning evidence. Resumability is asserted separately, by
        // a NEW request, in the `resume` phase.
        record(args, {
          gate: `PX7-open-stream-interrupted:${ref(item)}`, verdict: 'pass',
          note: `the held-open response failed after ${stream.bytesRead} bytes, which is the expected `
            + 'outcome of killing the daemon under it. This is NOT open-handle evidence.',
        });
        return;
      }

      record(args, exactly(`PX7-pinned-stream-bytes:${ref(item)}`, result.bytes, expected.sizeBytes));
      record(args, {
        gate: `PX7-pinned-stream-digest:${ref(item)}`,
        verdict: result.sha256 === expected.sha256 ? 'pass' : 'fail',
        note: 'the digest is over everything ONE response delivered, across the event',
      });
      // ANTI-BUFFERING. A body already buffered in full would show nothing arriving after the event, and
      // "held open" would be a fiction.
      const after = result.bytes - bytesBefore;
      record(args, atLeast(`PX7-bytes-after-event:${ref(item)}`, after,
        Math.floor(expected.sizeBytes / 10),
        'a measured share of the file arrived AFTER the event, so the response was genuinely mid-delivery'));
      return;
    }

    case 'resume': {
      // PLAYBACK IS RESUMABLE, which is the half of G12 the acceptance plan says IS required. A NEW request,
      // deliberately, because the point is that the data plane came back rather than that a handle survived.
      const state = readState(need(args, 'state'));
      const items = await listMovies(state);
      const item = itemFor(items, need(args, 'key'));
      const expected = readExpected(need(args, 'expect-file')).find((entry) => entry.key === item.key);
      if (expected === undefined) throw new GateFailure('nothing was published under that name');
      const result = await directPlay(state, item, expected.sizeBytes);
      record(args, {
        gate: `PX8-resumable-digest:${ref(item)}`,
        verdict: result.sha256 === expected.sha256 && result.bytes === expected.sizeBytes ? 'pass' : 'fail',
        note: 'a new request after the event returns the published bytes',
      });
      return;
    }

    case 'compare': {
      // THE CHURN GATE. A re-scan, a crash recovery or a media-server restart must not make a library move.
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

      const counts = new Map<string, number>();
      for (const item of after) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
      record(args, exactly(`${gate}-duplicates`,
        [...counts.values()].filter((count) => count > 1).length, 0));

      // IDENTITY, NOT JUST PRESENCE. A server that re-created an item under a new ratingKey has lost every
      // piece of watch state attached to it, and a count comparison would call that a clean re-scan.
      let churned = 0;
      let guidChurn = 0;
      for (const item of before) {
        const current = after.find((entry) => entry.key === item.key);
        if (current === undefined) continue;
        if (current.ratingKey !== item.ratingKey) churned += 1;
        if (current.guid !== item.guid) guidChurn += 1;
      }
      record(args, exactly(`${gate}-item-id-churn`, churned, 0,
        'carried items keep the ratingKey they were first given'));
      record(args, exactly(`${gate}-guid-churn`, guidChurn, 0));

      let moved = 0;
      for (const item of before) {
        const current = after.find((entry) => entry.key === item.key);
        if (current && (current.sizeBytes !== item.sizeBytes || current.container !== item.container)) {
          moved += 1;
        }
      }
      record(args, exactly(`${gate}-metadata-drift`, moved, 0));
      return;
    }

    case 'counters': {
      // A ref'd watchdog, for the same reason every other request here has one.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(need(args, 'url'), { signal: controller.signal })
        .finally(() => clearTimeout(timer));
      if (!response.ok) fail(`the provider counters endpoint answered ${response.status}`);
      const snapshot = await response.json() as ProviderCounterSnapshot;
      writeFileSync(need(args, 'out'), `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(`  provider counters: ${JSON.stringify(snapshot)}`);
      return;
    }

    case 'budget': {
      const before = JSON.parse(readFileSync(need(args, 'before'), 'utf8')) as ProviderCounterSnapshot;
      const after = JSON.parse(readFileSync(need(args, 'after'), 'utf8')) as ProviderCounterSnapshot;
      const gate = need(args, 'gate');
      const entries = optionalNumber(args, 'entries', 1);
      const delta = (key: string): number => counterValue(after, key) - counterValue(before, key);
      // AN EXPLICIT `--windows 0` MEANS THIS WINDOW MAY COST NOTHING AT ALL, and it forces every class and
      // every byte to zero. It is what the warm re-scan uses: a second scan of an unchanged generation is
      // served entirely from the daemon's persistent probe cache, and "zero" there is the whole assertion.
      // A default of zero would be wrong, so it is only the EXPLICIT flag that does this.
      const zeroWindow = args.flags.get('windows') === '0';
      const caps = zeroWindow
        ? { block: 0, small: 0, oversized: 0, bodyless: 0, total: 0 }
        : plexScanRequestCeilings(entries);

      // THE REQUEST BUDGET IS PER RESPONSE CLASS, NOT ONE TOTAL.
      //
      // A single ceiling of eleven can be spent as eleven 4 MiB demand blocks — 44 MiB — which is not what
      // any observation looks like and is not what the budget means to permit. Capping each class separately
      // means the expensive class has its own limit and the cheap one cannot lend it headroom. The total is
      // asserted too, as a cross-check, but it is the per-class caps that constrain the mix.
      //
      // FULL AND CLIPPED BLOCKS ARE SUMMED AND HELD TO ONE CAP, WHICH gate7 IS THE REASON FOR. That run's
      // corpus window served 0 full blocks and 13 clipped ones and failed a budget asserting the clipped
      // class could not exist. It can: `readpath.demandBlock` clips a block to the gap between cached probe
      // windows, so a read bounded by cached data legitimately returns less than a full block. Both are one
      // block-sized fetch, so both spend the same allowance — and a clipped block can never cost more bytes
      // than a full one, so admitting the class widened no byte budget.
      const blockResponses = delta('chunkResponses') + delta('partialResponses');
      record(args, withinBudget(`${gate}-block-responses`, blockResponses, caps.block,
        `${entries} entries x ${PLEX_SCAN_ENVELOPE.BLOCK} block-sized fetches, full or clipped `
        + `(${delta('chunkResponses')} full, ${delta('partialResponses')} clipped). EMPIRICAL WATCHDOG: `
        + `highest MEASURED is ${plexHighestMeasuredPerEntry('blocks')} per entry across `
        + `${plexInstrumentedWindowCounts().total} instrumented windows `
        + `(${plexInstrumentedWindowCounts().diagnostic} diagnostic, ${plexInstrumentedWindowCounts().gate} `
        + `in a full gate); ${PLEX_GATE6_COMPATIBLE_BLOCKS.BLOCKS} is INFERRED, the decomposition compatible `
        + `with the uninstrumented gate6 aggregate of ${PLEX_GATE6_COMPATIBLE_BLOCKS.REQUESTS} requests / `
        + `${PLEX_GATE6_COMPATIBLE_BLOCKS.BYTES} bytes. A breach is a finding to investigate, never a bump`));
      record(args, withinBudget(`${gate}-small-responses`, delta('smallResponses'), caps.small,
        `${entries} entries x ${PLEX_SCAN_ENVELOPE.SMALL} probe-window reads; highest measured is `
        + `${plexHighestMeasuredPerEntry('small')} per entry across every instrumented window`));
      record(args, exactly(`${gate}-oversized-responses`, delta('oversizedResponses'), caps.oversized,
        'a body LARGER than one demand block can only be a coalesced read or a full body answering a '
        + 'ranged request, and neither has ever occurred'));
      record(args, exactly(`${gate}-bodyless-responses`, delta('bodylessResponses'), caps.bodyless,
        'a ranged request the endpoint refused has never occurred in a healthy window'));
      record(args, withinBudget(`${gate}-range-requests`, delta('rangeRequests'), caps.total,
        `${entries} entries x ${PLEX_SCAN_ENVELOPE.TOTAL}; a cross-check on the per-class caps above, which `
        + 'are what stop this being spendable as demand blocks'));
      record(args, withinBudget(`${gate}-resolutions`, delta('resolutions'),
        zeroWindow ? 0 : Math.ceil(entries * MEDIA_SERVER_BUDGETS.MAX_SCAN_RESOLUTION_MULTIPLIER),
        `denominator: ${entries} remote entries`));
      // THE BYTE CEILING IS THE CLASS FORMULA EVALUATED AT THE OBJECT'S LENGTH.
      //
      // BLOCK x min(4 MiB, size) + SMALL x min(1 MiB, size). One expression, no second rule beside it and
      // nothing in it fitted: the caps asserted above, asked what they permit for an object this long.
      //
      // IT SATURATES AT ONE DEMAND BLOCK — 4 MiB, being `max(CHUNK_BYTES, PROBE_WINDOW_BYTES)`. At or above
      // that, an object can serve full blocks and full probe windows, so it earns the whole 36,700,160-byte
      // envelope and every larger object earns exactly the same. Shorter objects earn less from the same
      // caps, because a 40 KB entry cannot serve a 4 MiB block: it is held to eleven reads of its own
      // length, 444,532 bytes.
      //
      // TWO RETIRED READINGS, RECORDED SO NEITHER IS REBUILT. This comment once said a scan satisfying every
      // request cap could not then fail on bytes, which was false. It then said the stricter of two halves
      // was a clamp below a crossover — also false, and by then describing a clamp that no longer existed:
      // there is no separate clamp and no crossover, only this one formula, flat from 4 MiB upward.
      //
      // THE OLD HALF-ENVELOPE FIGURE IS GONE. It marked where the retired clamp met the envelope; with no
      // clamp there is no such point, and the ceiling has been flat from one demand block upward regardless.
      //
      // WHAT IT REPLACES, AND WHY THAT ONE WAS WRONG. The previous ceiling was
      // `opens x min(blocks x chunk, size)` = 24 MiB saturated, and gate6 exceeded it: 32,505,856 against
      // 25,165,824. It was built on a per-open apportionment the aggregate counters cannot support and on a
      // demand-block count that proved load- and timing-sensitive rather than fixed.
      //
      // ON A SMALL OBJECT THIS CEILING STILL PERMITS A WHOLE-OBJECT READ, so satisfying it proves nothing
      // about the fraction — a limit of the instrument, not a lower bound, and not a claim that a below-one
      // read is impossible there. The fraction is asserted separately, on one object large enough for it to
      // mean something: `--large-bytes`. On the 105 MB fixture the envelope is 0.348 of the object, tighter
      // than the 0.5 fraction — so the ENVELOPE is what binds there and the fraction cannot fail on its own.
      // The fraction stays the explicit headline because it is the product's claim in the product's terms;
      // calling it the binding constraint here would overstate the gate.
      // EVERY BYTE TERM COMES FROM `--object-sizes`, ONE OBJECT AT A TIME. `--bytes` and `--small-bytes` are
      // GONE, not merely unused: they named a pooled remote total, and a pooled total is exactly what let one
      // large object pay for thirty-eight tiny ones. The request and resolution denominators come from
      // `--entries`. Nothing in this phase reads a pooled byte figure any more, so nothing accepts one.
      // EVERY TOKEN IS PARSED, AND A BAD ONE IS FATAL RATHER THAN DROPPED.
      //
      // THE DEFECT THIS CLOSES. This used to `.filter()` out anything that was not a finite positive number,
      // which meant `1000,,2000` silently became a two-object denominator, `abc,2000` a one-object one, and a
      // shell variable that expanded to nothing an empty list — and an empty list skipped the byte ceiling
      // altogether. Every one of those makes the budget LOOSER than the gate reads as, invisibly, from a
      // typo. The denominator of a budget is not a place to be forgiving.
      const rawSizes = (args.flags.get('object-sizes') ?? '').trim();
      const sizes = rawSizes === '' ? [] : rawSizes.split(',').map((token) => {
        const size = Number(token.trim());
        if (token.trim() === '' || !Number.isFinite(size) || size <= 0) {
          fail(`--object-sizes contains ${JSON.stringify(token)}, which is not a positive byte count. `
            + 'Every object in the window must name its own size; dropping one would quietly shrink the '
            + 'denominator the byte budget is measured against');
        }
        return size;
      });
      // AND FOR ANY WINDOW THAT IS NOT AN EXPLICIT ZERO, THE FLAG IS REQUIRED. The usage line has always
      // declared it so. Absent it, the byte ceiling simply did not run and the phase still reported success.
      if (!zeroWindow && sizes.length === 0) {
        fail('--object-sizes is required for a budget window: without it no provider-byte ceiling can be '
          + 'computed, and a phase that silently omits its byte assertion is the failure this gate exists '
          + 'to catch. The one size-free form is an explicit --windows 0, which asserts zero bytes instead');
      }

      // A ZERO WINDOW IS ASSERTED WITHOUT REFERENCE TO ANY OBJECT, AND THAT IS WHY THIS SITS OUTSIDE THE
      // `sizes` GUARD.
      //
      // THE DEFECT THIS CLOSES, AND IT WAS THE WORST KIND. The byte assertion used to live inside
      // `if (sizes.length > 0)`. `PX14`, the warm re-scan, passes `--entries 1 --windows 0` and NO
      // `--object-sizes` — it has no reason to name a size, because it asserts that the provider was not
      // touched at all. So the whole block was skipped and **no byte assertion ran**: the re-scan window
      // could have served any number of bytes and this phase would have reported nothing about it, while the
      // code comment, the document and an offline test all said `--windows 0` forced bytes to zero. A check
      // that cannot fail, described as the strongest amplification claim the gate makes.
      //
      // Zero needs no denominator. `exactly` rather than a ceiling of zero, so a negative delta — counters
      // reset underneath the window — is a failure too rather than something "within budget".
      if (zeroWindow) {
        record(args, exactly(`${gate}-provider-bytes`, delta('bytesServed'), 0,
          'an explicit --windows 0 window asserts the provider was not touched: zero bytes, whether or not '
          + 'any object size was named'));
        // An explicit zero window asserts zero above; a floor beneath it would contradict that outright.
        record(args, {
          gate: `${gate}-provider-bytes-floor-not-applicable`, verdict: 'pass',
          note: 'an explicit --windows 0 window is asserted at zero, so it carries no floor',
        });
      } else if (sizes.length > 0) {
        // ORDINARY BYTE BUDGETING STILL REQUIRES SIZES, because every term of it is per object.
        //
        // AND IT IS NOW ASSERTED PER OBJECT, WHICH IS WHAT gate8 FORCED. That run exceeded the SUMMED ceiling
        // by 47,065 bytes across forty objects and the telemetry could not say which one spent them: one
        // large object read twice over looks exactly like thirty-eight small ones taking an extra pass. The
        // endpoint now attributes bytes per registered object, so each entry answers for itself.
        //
        // THE PER-OBJECT LIMIT IS THE CAPS' OWN ARITHMETIC, not a fitted multiple. The retired 2x clamp was
        // refuted by gate8's 2.001951x; raising it to clear that run would have fitted a constant to a
        // measurement whose subject was unknown, because the window pooled forty objects.
        // EVERY ELEMENT IS VALIDATED, AND A MALFORMED ARRAY IS FATAL RATHER THAN EMPTY.
        //
        // These arrive as JSON from the endpoint over HTTP. Casting them to number[] and hoping is how a
        // budget ends up computing verdicts from `undefined`. NaN comparisons are all false, so those
        // verdicts FAIL rather than pass — an earlier version of this comment had that backwards — but they
        // fail meaninglessly, naming the data plane for what is a broken counters file. A broken instrument
        // says so by name, at the point it is read.
        const readCounterArray = (snapshot: Record<string, unknown>, key: string): number[] | undefined => {
          const raw = snapshot[key];
          if (raw === undefined) return undefined;
          if (!Array.isArray(raw)) {
            fail(`${key} is ${typeof raw} rather than an array; the counters endpoint is not what this `
              + 'phase was written against');
          }
          return (raw as unknown[]).map((element, index) => {
            if (typeof element !== 'number' || !Number.isFinite(element)
              || element < 0 || !Number.isInteger(element)) {
              fail(`${key}[${index}] is ${JSON.stringify(element)}, which is not a non-negative whole `
                + 'number of bytes. A per-object verdict computed from it would fail against NaN and blame '
                + 'the object for a broken counters file');
            }
            return element as number;
          });
        };
        // THE BEFORE SNAPSHOT MUST SAY SO EXPLICITLY. `?? []` treated a MISSING array as "no cumulative
        // history", which is not the same statement at all: it silently reads every AFTER total as though it
        // had all been served inside this window. On a window opened late in a run that turns another
        // phase's traffic into this one's, and the direction of the error is always toward a bigger
        // measured delta being attributed here. A counters file without the field is an older or foreign
        // endpoint, not an endpoint that had served nothing.
        const objectBytesBeforeRaw = readCounterArray(before, 'objectBytes');
        const objectBytesAfter = readCounterArray(after, 'objectBytes') ?? [];
        if (objectBytesAfter.length > 0 && objectBytesBeforeRaw === undefined) {
          fail('the AFTER counters carry per-object attribution but the BEFORE counters do not. Treating '
            + 'the missing history as zero would attribute every byte this endpoint has ever served to this '
            + 'one window. Take both snapshots from the same endpoint');
        }
        const objectBytesBefore = objectBytesBeforeRaw ?? [];
        // THE SIZES COME FROM THE ENDPOINT, IN THE ENDPOINT'S OWN ORDER, and that is not a convenience.
        // `--object-sizes` is in the GATE's order; the attribution array is in registration order. Pairing
        // them by position would judge one object against another's length and report confident per-object
        // verdicts about the wrong objects. The endpoint knows every size because the gate told it, so it
        // answers with them and the two orderings never meet.
        const objectSizes = readCounterArray(after, 'objectSizes') ?? [];

        // THE CLASS COLUMNS, READ WITH THE SAME FAIL-CLOSED RULE AS THE BYTES.
        //
        // MY FIRST DRAFT USED `?? []` ON THE **BEFORE** SIDE, WHICH IS THE DEFECT I HAD JUST FIXED FOR
        // `objectBytes`, REINTRODUCED ONE FUNCTION LOWER. An absent BEFORE column is not "this object had no
        // class traffic yet"; it is a counters file that cannot describe the window. Treating it as zero
        // charges every response the endpoint has EVER classified to this one window, and the error always
        // runs toward a larger delta, which is the direction that invents breaches.
        const CLASS_COLUMNS = ['objectChunk', 'objectSmall', 'objectPartial', 'objectOversized'] as const;
        type ClassColumn = typeof CLASS_COLUMNS[number];
        const classDelta: Record<string, number[]> = {};
        let classColumnsUsable = true;
        for (const column of CLASS_COLUMNS) {
          const beforeColumn = readCounterArray(before, column);
          const afterColumn = readCounterArray(after, column);
          if (afterColumn === undefined || beforeColumn === undefined) {
            record(args, {
              gate: `${gate}-provider-${column}-present`, verdict: 'fail',
              measured: afterColumn === undefined ? 0 : 1, budget: 1,
              note: `${column} is missing from the ${afterColumn === undefined ? 'AFTER' : 'BEFORE'} `
                + 'counters. The per-object class caps are what the byte formula is derived from, so a '
                + 'window without them is unbudgeted rather than cheaply budgeted',
            });
            classColumnsUsable = false;
            continue;
          }
          // TWO EXACT EQUALITIES, NOT AN INEQUALITY, AND THE BEFORE ONE IS THE SUBTLE HALF.
          //
          // AFTER must equal objectBytesAfter: every attributed object needs its class counts.
          //
          // BEFORE must equal objectBytesBefore — not merely be no longer than AFTER. A class column
          // TRUNCATED relative to the byte column describes an object that WAS already registered, and
          // `?? 0` would then read its missing history as "no class traffic yet" and charge this window with
          // everything the endpoint had ever classified for it. Objects registered DURING the window are the
          // legitimate case and are unaffected: they are absent from objectBytesBefore and from every class
          // BEFORE column together, so the two lengths still match and the new ordinals start from zero.
          if (afterColumn.length !== objectBytesAfter.length
            || beforeColumn.length !== objectBytesBefore.length) {
            record(args, {
              gate: `${gate}-provider-${column}-aligned`, verdict: 'fail',
              measured: afterColumn.length, budget: objectBytesAfter.length,
              note: `${column} is ${beforeColumn.length} before and ${afterColumn.length} after, against `
                + `${objectBytesBefore.length} and ${objectBytesAfter.length} for the byte attribution it `
                + 'shares ordinals with. A short BEFORE column would re-charge an already-registered '
                + 'object\'s lifetime class traffic to this window',
            });
            classColumnsUsable = false;
            continue;
          }
          classDelta[column] = afterColumn.map((value, index) => value - (beforeColumn[index] ?? 0));
        }
        const classFor = (column: ClassColumn, index: number): number => classDelta[column]?.[index] ?? 0;

        // FAIL CLOSED. Attribution is what carries the per-object claim, so its ABSENCE cannot be a quiet
        // downgrade to the aggregate — that is a window whose headline assertion silently did not run, which
        // is the defect PX14 already taught this gate once. Missing, empty, or two arrays of different
        // lengths: each is a broken instrument and each fails here, named.
        const perObject = objectBytesAfter.length > 0 && objectSizes.length === objectBytesAfter.length;
        if (!perObject) {
          const why = objectBytesAfter.length === 0
            ? 'the endpoint reported no per-object byte attribution at all'
            : `the endpoint reported ${objectBytesAfter.length} per-object byte totals but `
              + `${objectSizes.length} sizes, so no object can be paired with its own length`;
          record(args, {
            gate: `${gate}-provider-bytes-per-object`, verdict: 'fail', measured: objectBytesAfter.length,
            budget: objectSizes.length,
            note: `${why}. The per-object ceiling is what binds this window, so a window without `
              + 'attribution is unbudgeted rather than cheaply budgeted',
          });
        }
        if (perObject && objectBytesBefore.length > objectBytesAfter.length) {
          // Objects cannot un-register. A shorter AFTER array means the endpoint restarted mid-window and
          // its counters began again, so every delta below would be measured against a stranger.
          record(args, {
            gate: `${gate}-provider-bytes-attribution-continuous`, verdict: 'fail',
            measured: objectBytesAfter.length, budget: objectBytesBefore.length,
            note: 'the endpoint knew fewer objects at the end of this window than at the start, so its '
              + 'counters were reset underneath the measurement',
          });
        }
        if (perObject) {
          // THE ATTRIBUTION PARTITION FIRST. If the per-object totals do not add up to the window's bytes, a
          // body went out for an object the endpoint never registered and the per-object verdicts below
          // would be judging an incomplete picture.
          const attributed = objectBytesAfter.reduce((total, bytes, index) =>
            total + (bytes - (objectBytesBefore[index] ?? 0)), 0);
          record(args, exactly(`${gate}-provider-bytes-attributed`, attributed, delta('bytesServed'),
            'every served byte is attributed to exactly one registered object; a shortfall means a body '
            + 'went out for a reference the endpoint never registered'));

          // ONE VERDICT PER OBJECT THAT MOVED. Objects that served nothing in this window are not asserted
          // on: a window that legitimately touches two of forty entries would otherwise emit thirty-eight
          // passes that say nothing, and a report padded with vacuous passes is how a gate stops being read.
          let worstRatio = 0;
          // TWO COUNTERS, BECAUSE ONE ROLL-UP CANNOT HONESTLY NAME TWO KINDS OF FAILURE. A byte-ratio note
          // over a count that includes class breaches tells an operator to go and look at bytes when the
          // breach was a fetch count, which is the sort of misdirection that costs an investigation.
          let byteBreaches = 0;
          let classBreaches = 0;
          for (let index = 0; index < objectBytesAfter.length; index += 1) {
            const servedBytes = (objectBytesAfter[index] ?? 0) - (objectBytesBefore[index] ?? 0);

            // WHAT "INACTIVE" MEANS, AND WHY ZERO BYTES IS NOT ENOUGH TO DECIDE IT.
            //
            // THE DEFECT THIS CLOSES. The loop skipped an object the moment its byte delta was zero, which
            // silently skipped its CLASS checks too. A zero-length body is classified SMALL by the endpoint,
            // so an object can legitimately move a class counter without moving a byte counter — and a
            // class counter that went BACKWARDS while bytes stayed still would have been read as "this
            // object did nothing" and passed. An object is inactive only when nothing moved at all.
            const classDeltasHere = classColumnsUsable
              ? CLASS_COLUMNS.map((column) => classFor(column, index))
              : [];
            const classesMoved = classDeltasHere.some((value) => value !== 0);

            // NEGATIVE CLASS DELTAS ARE CHECKED BEFORE ANY SKIP, for the same reason: a reset is the reading
            // least likely to be benign and the one that would otherwise pass unexamined.
            let classWentBackwards = false;
            for (const [position, column] of CLASS_COLUMNS.entries()) {
              if ((classDeltasHere[position] ?? 0) >= 0) continue;
              record(args, {
                gate: `${gate}-provider-${column}-object-${index}`, verdict: 'fail',
                measured: classDeltasHere[position],
                note: 'this object\'s class counter fell across the window, so the endpoint counters were '
                  + 'reset and nothing measured here describes the window',
              });
              classBreaches += 1;
              classWentBackwards = true;
            }
            // A BYTE COUNTER THAT WENT BACKWARDS, CHECKED BESIDE THE CLASS ONE RATHER THAN AFTER IT.
            //
            // THE DEFECT THIS CLOSES. `continue`ing the moment a CLASS counter went backwards skipped this
            // check entirely, so an object whose bytes AND classes both reset was recorded as a class
            // breach only — and the BYTE roll-up, having counted nothing, PASSED. Both resets are real,
            // both are reported, and only then is the object abandoned as unmeasurable.
            let bytesWentBackwards = false;
            if (servedBytes < 0) {
              record(args, {
                gate: `${gate}-provider-bytes-object-${index}`, verdict: 'fail', measured: servedBytes,
                note: 'this object served a NEGATIVE number of bytes across the window, so the endpoint '
                  + 'counters were reset and nothing measured here describes the window',
              });
              byteBreaches += 1;
              bytesWentBackwards = true;
            }
            if (classWentBackwards || bytesWentBackwards) continue;
            if (servedBytes === 0 && !classesMoved) continue;
            // BYTE CHECKS RUN ONLY WHEN BYTES MOVED. An object whose classes moved with a zero byte delta
            // is still ACTIVE — a zero-length body is classified SMALL — and its class caps below must be
            // reached. Gating the whole tail on bytes is what hid that case.
            if (servedBytes > 0) {
              const size = objectSizes[index];
              if (size === undefined || size <= 0) {
                record(args, {
                  gate: `${gate}-provider-bytes-object-${index}`, verdict: 'fail', measured: servedBytes,
                  note: 'this object served bytes but the endpoint reports no length for it, so no ceiling '
                    + 'can be computed and the verdict cannot be reached',
                });
                byteBreaches += 1;
              } else {
                worstRatio = Math.max(worstRatio, servedBytes / size);
                if (servedBytes > plexObjectByteCeiling(size)) {
                  record(args, withinBudget(`${gate}-provider-bytes-object-${index}`, servedBytes,
                    plexObjectByteCeiling(size),
                    `a ${size}-byte object served ${(servedBytes / size).toFixed(3)}x its own length`));
                  byteBreaches += 1;
                }
              }
            }

            // AND THE CLASS CAPS THE BYTE CEILING IS DERIVED FROM, ASSERTED ON THIS OBJECT, ALWAYS.
            //
            // The byte ceiling is BLOCK x min(4 MiB, size) + SMALL x min(1 MiB, size). Checking only the
            // bytes leaves its two terms unchecked: an object could stay inside the byte figure while making
            // far more block-sized fetches than BLOCK permits, each one small because the object is short.
            // These are the same caps the aggregate asserts, evaluated where they were derived — per object.
            // Negative deltas were already failed above, before any skip.
            if (!classColumnsUsable) continue;
            const blockClass = classFor('objectChunk', index) + classFor('objectPartial', index);
            if (blockClass > PLEX_SCAN_ENVELOPE.BLOCK) {
              record(args, withinBudget(`${gate}-provider-block-class-object-${index}`, blockClass,
                PLEX_SCAN_ENVELOPE.BLOCK,
                `${classFor('objectChunk', index)} full and ${classFor('objectPartial', index)} clipped `
                + 'block fetches for one object; full and clipped share one allowance because both are one '
                + 'block-sized fetch'));
              classBreaches += 1;
            }
            if (classFor('objectSmall', index) > PLEX_SCAN_ENVELOPE.SMALL) {
              record(args, withinBudget(`${gate}-provider-small-class-object-${index}`,
                classFor('objectSmall', index), PLEX_SCAN_ENVELOPE.SMALL,
                'probe-window reads for one object, against the cap the byte formula uses'));
              classBreaches += 1;
            }
            if (classFor('objectOversized', index) !== PLEX_SCAN_ENVELOPE.OVERSIZED) {
              record(args, exactly(`${gate}-provider-oversized-class-object-${index}`,
                classFor('objectOversized', index), PLEX_SCAN_ENVELOPE.OVERSIZED,
                'a body larger than one demand block, attributed to this object'));
              classBreaches += 1;
            }
          }
          // AND THE COLUMNS RECONCILE WITH THE AGGREGATE, which is a different question from the caps
          // above: the caps ask whether each object behaved, this asks whether the attribution is complete.
          // A response classified for the window but attributed to no object would pass every per-object
          // check by never appearing in one.
          for (const [column, aggregate] of [
            ['objectChunk', 'chunkResponses'], ['objectSmall', 'smallResponses'],
            ['objectPartial', 'partialResponses'], ['objectOversized', 'oversizedResponses'],
          ] as Array<[ClassColumn, string]>) {
            if (!classColumnsUsable) break;
            const summed = (classDelta[column] ?? []).reduce((total, value) => total + value, 0);
            record(args, exactly(`${gate}-provider-${column}-reconciles`, summed, delta(aggregate),
              `the per-object ${column} column must sum to the window's ${aggregate} delta; a shortfall `
              + 'means a response was classified for the window but attributed to no object'));
          }
          // TWO ROLL-UPS, EACH NAMING ONLY WHAT IT COUNTS. The byte one keeps its byte-ratio note; the class
          // one is about fetch counts and says so. A single figure under a byte-shaped note would send an
          // operator to look at bytes when what breached was a count of fetches.
          record(args, exactly(`${gate}-provider-bytes-per-object`, byteBreaches, 0,
            `${objectBytesAfter.length} objects attributed, worst ${worstRatio.toFixed(3)}x of its own `
            + 'length, each against the class formula evaluated at that length'));
          // AND IT CANNOT PASS WHEN THE COLUMNS WERE UNUSABLE. A structural failure above — a missing or
          // misaligned class column — means no per-object class cap was evaluated at all, so a roll-up
          // reporting zero breaches would contradict the very gate that just failed. It reports the
          // structural failure instead of a count it never took.
          if (!classColumnsUsable) {
            record(args, {
              gate: `${gate}-provider-classes-per-object`, verdict: 'fail', measured: classBreaches,
              note: 'the per-object class columns were missing or misaligned, so no per-object class cap '
                + 'was evaluated in this window. Zero breaches here would mean nothing was checked, not '
                + 'that nothing breached',
            });
          } else {
            record(args, exactly(`${gate}-provider-classes-per-object`, classBreaches, 0,
              `${objectBytesAfter.length} objects attributed; each held to ${PLEX_SCAN_ENVELOPE.BLOCK} `
              + `block-sized fetches (full and clipped together), ${PLEX_SCAN_ENVELOPE.SMALL} probe `
              + `windows, and ${PLEX_SCAN_ENVELOPE.OVERSIZED} larger than a demand block. A class-counter `
              + 'reset counts as a breach too, because a reset means nothing here describes the window'));
          }
        }

        // THE AGGREGATE CEILING STAYS AT EXACTLY THE SUM OF THE PER-OBJECT ONES, AND NOT A BYTE MORE.
        //
        // I nearly wrote a scaling factor here so the sum would sit above the per-object verdicts. That is
        // the fitted-constant move this gate has rejected three times, and it is unnecessary: if every
        // object is inside its own ceiling then the total is inside their sum, arithmetically. So when
        // attribution is available this assertion is IMPLIED by the ones above, and the only way it can fail
        // while they pass is unattributed bytes — which the partition catches first and names as such.
        //
        // It is kept anyway, at the honest value, because attribution is not available on every window.
        // BOTH COLUMNS — see `providerByteResults`. The committed column is what the endpoint undertook to
        // serve, and a demand block the daemon abandons part-way is counted there in full.
        for (const result of providerByteResults(gate, {
          committed: delta('bytesServed'),
          observed: delta('observedBytes'),
          truncatedBodies: delta('truncatedBodies'),
        }, plexScanByteCeiling(sizes),
        `${sizes.length} remote objects, each at most the per-class maximum for its own length`
          + (perObject ? '; implied by the per-object verdicts above, which are what bind' : ''))) {
          record(args, result);
        }
        // A FLOOR SUMMED FROM PER-OBJECT TERMS — WHICH MAKES IT AN AGGREGATE, NOT A PER-OBJECT ASSERTION.
        //
        // AN EARLIER VERSION OF THIS COMMENT CLAIMED CROSS-SUBSIDY WAS RULED OUT HERE. THAT WAS FALSE. The
        // measurement is `bytesServed`, one number for the window, so a run that opened two large objects and
        // none of the other thirty-eight clears this floor easily on the strength of the two.
        //
        // AND THE REASON IS NO LONGER THAT THE ENDPOINT CANNOT ATTRIBUTE — IT CAN, AND THE CEILING ABOVE USES
        // IT. What this phase lacks is the other half of the mapping: `--object-sizes` names the objects the
        // WINDOW is about, in the caller's order, and nothing here relates that set to the endpoint's
        // ordinals. The ceiling does not need the relation, because each object is judged against the
        // endpoint's own size for it; a per-object FLOOR would, because a floor is a claim about which
        // objects should have been READ, and only the caller knows which those are. Implementing that
        // mapping is what would make the floor per-object. Until then the floor proves the window was not
        // free; which entries paid for it, it cannot say.
        //
        // THE DEFECT THIS CLOSES. It was `min(totalRemote, count x 1 MiB)`, and `totalRemote` came from
        // `--bytes`, which defaults to 1 — so on the restart-scan call, which names sizes but no `--bytes`,
        // the floor collapsed to 1 byte and the check could not fail. Worse, even when `--bytes` was given
        // the two terms were pooled: thirty-eight tiny objects that were never opened could be paid for by
        // one large one that was.
        //
        // The least a scanner that really looked at an object could have cost is one probe window, or the
        // whole object when the object is smaller than a window. Summing THAT per object gives a floor no
        // single entry can cover for another.
        //
        // ...EXCEPT ON A WINDOW THAT MAY LEGITIMATELY BE WARM, WHICH `--warm-capable` NAMES.
        //
        // THE DEFECT THIS CLOSES. The scan after a media-server restart was given this floor, and a real run
        // then measured it at ZERO provider bytes — because the daemon's persistent probe cache served
        // everything Plex re-read, which is the behaviour the cache exists for. The floor turned the desired
        // outcome into a failure, and it contradicted `PX14`, which asserts zero for the same situation.
        // An earlier run of the same window had measured +37,924,876 bytes, so BOTH outcomes are valid and
        // no floor can be right for it.
        //
        // The ceilings stay: a warm-capable window may cost nothing, and it may not cost more than a cold
        // one. Only the floors are dropped, only where the flag says so, and never on a scan that is
        // expected to reach the provider.
        // A ZERO WINDOW NEVER REACHES HERE. It is handled in the branch above, which asserts zero bytes and
        // records `-provider-bytes-floor-not-applicable` itself. This arm used to re-test `zeroWindow` and
        // emit that same record a second time — unreachable, because the enclosing `else if` already proves
        // it false, and duplicative if it ever had been reached.
        if (args.flags.get('warm-capable') === 'true') {
          record(args, {
            gate: `${gate}-provider-bytes-warm-capable`, verdict: 'pass',
            measured: delta('bytesServed'), budget: plexScanByteCeiling(sizes),
            note: 'no floor: this window may legitimately be served entirely from the daemon\'s persistent '
              + 'probe cache. Zero is valid cache reuse; a cold-scan cost is also valid. The ceiling above '
              + 'still applies.',
          });
        } else {
          const floorBytes = sizes.reduce(
            (total, size) => total + Math.min(size, PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES), 0,
          );
          record(args, atLeast(`${gate}-provider-bytes-floor`, delta('bytesServed'), floorBytes,
            'one probe window per object, or the object itself when it is smaller than a window; a scan '
            + 'that read less than that did not open the entries'));
        }
      }
      // THE PRODUCT'S OWN CLAIM, ASSERTED WHERE IT IS MEANINGFUL. Against an object several times larger
      // than the fixed scan window, a scanner that downloaded it to identify it sits at 1.0 and the daemon
      // must sit well under. This uses the SHARED fraction, not one of Plex's own.
      // THE REQUEST SHAPE, RECORDED SO THE NEXT BUDGET CAN BE DERIVED INSTEAD OF GUESSED.
      //
      // A window that cost 32,505,856 bytes over 10 ranged requests cannot be turned into a budget: 7.75
      // demand blocks is not a whole number of anything, so the total is some unknown mix of full 4 MiB
      // blocks and smaller probe or tail reads. Decomposing it is the difference between a ceiling derived
      // from geometry and a multiplier picked to clear an observation. These four buckets are cumulative
      // counts and byte totals only — no offsets, no references, no per-request sequence — and they sum to the bytes
      // served, which is asserted so a response that escaped classification is visible rather than silent.
      //
      // FOUR AND NOT THREE, BECAUSE THE MIDDLE ONE WAS HIDING TWO DIFFERENT THINGS. A block clipped by a
      // cache gap and a body larger than a demand block both used to land in "other", so no budget could
      // admit the first without admitting the second. gate7 met thirteen of the first and failed.
      const shape = (key: string): number => delta(key);
      const bucketedBytes = shape('chunkBytes') + shape('smallBytes')
        + shape('partialBytes') + shape('oversizedBytes');
      const bucketedRequests = shape('chunkResponses') + shape('smallResponses')
        + shape('partialResponses') + shape('oversizedResponses');
      record(args, {
        gate: `${gate}-request-shape`, verdict: 'pass',
        note: `${shape('chunkResponses')} responses of exactly one 4 MiB demand block `
          + `(${shape('chunkBytes')} bytes), ${shape('partialResponses')} clipped blocks over a probe `
          + `window and under a demand block (${shape('partialBytes')} bytes), `
          + `${shape('smallResponses')} of one probe window or less (${shape('smallBytes')} bytes), `
          + `${shape('oversizedResponses')} larger than a demand block (${shape('oversizedBytes')} bytes)`,
      });
      record(args, exactly(`${gate}-request-shape-accounts-for-every-byte`,
        bucketedBytes, delta('bytesServed'),
        'the four buckets partition the bytes served; a shortfall means a response was not classified'));
      // ...AND FOR EVERY REQUEST, WHICH THE BYTE PARTITION ALONE DOES NOT CATCH.
      //
      // Bytes summing correctly says nothing about the COUNT: two responses filed as one, or a served body
      // that incremented no bucket while its bytes were counted elsewhere, both leave the byte total intact.
      // The count is what a request geometry would be derived from, so it gets its own gate.
      //
      // THE BODYLESS TERM IS ONE COUNTER, NOT A LIST OF KNOWN FAULTS. The first draft of this equation added
      // back `served429 + expiredRejected` — and the endpoint returns without a body in a dozen other places:
      // an unknown object, a missing file, a malformed Range, 401, 403, 410, 503, a timeout, a redirect. It
      // was short on every one of them while its gate id claimed to account for every request. The endpoint
      // now counts bodyless returns structurally, so this side does not enumerate anything and cannot go
      // stale when a fault is added.
      // AND IT RECONCILES AGAINST ACCOUNTED RESPONSES, NOT ARRIVALS — WHICH gate9 IS THE REASON FOR.
      //
      // THE DEFECT THIS CLOSES. This compared the classified buckets to `rangeRequests`, which the endpoint
      // increments when a request ARRIVES, while the class is recorded when the body is served. A request in
      // flight across a snapshot is therefore counted on one side only, and gate9's PX9 window failed 5
      // against 4 for exactly that reason: one request had arrived before the window opened and was
      // classified inside it. The byte partition passed throughout, because bytes and class move together.
      //
      // `accountedResponses` advances in the same critical section as the class, so both sides of this
      // identity move at one point in the request's life and the equation holds with any number in flight.
      // Arrivals remain the denominator for the request CEILING above, which genuinely wants arrivals.
      record(args, exactly(`${gate}-request-shape-accounts-for-every-request`,
        bucketedRequests + shape('bodylessResponses'), delta('accountedResponses'),
        `${bucketedRequests} classified responses plus ${shape('bodylessResponses')} that served no body `
        + 'must equal every response the endpoint accounted for in this window'));
      // IN-FLIGHT AT THE BOUNDARIES, RECORDED RATHER THAN INFERRED. A window whose arrivals and accounted
      // responses differ had a request straddling it; that is normal and is not a failure, but a reader
      // comparing the two counters deserves to be told rather than left to deduce it.
      if (delta('rangeRequests') !== delta('accountedResponses')) {
        record(args, {
          gate: `${gate}-requests-in-flight-at-a-boundary`, verdict: 'pass',
          measured: delta('rangeRequests'), budget: delta('accountedResponses'),
          note: 'arrivals and accounted responses differ across this window, so a request straddled one of '
            + 'its boundaries. The partition above is asserted on accounted responses precisely so this is '
            + 'a recorded observation rather than a failure',
        });
      }

      const largeBytes = optionalNumber(args, 'large-bytes', 0);
      if (largeBytes > 0) {
        record(args, withinBudget(`${gate}-large-object-byte-fraction`,
          Math.round((delta('bytesServed') / largeBytes) * 1000) / 1000,
          PLEX_LARGE_FIXTURE.MAX_SCAN_BYTE_FRACTION,
          `identifying a ${largeBytes}-byte object read this fraction of it; a scanner that downloaded it `
          + 'to identify it would sit at 1.0'));
      }
      record(args, withinBudget(`${gate}-http-429`, delta('served429'), MEDIA_SERVER_BUDGETS.MAX_HTTP_429));
      record(args, withinBudget(`${gate}-full-body-on-range`, delta('fullBodyServed'),
        MEDIA_SERVER_BUDGETS.MAX_FULL_BODY_SERVED));
      record(args, withinBudget(`${gate}-peak-connections`, counterValue(after, 'peakConns'),
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS));
      const floor = args.flags.get('min-range');
      if (floor !== undefined) {
        record(args, atLeast(`${gate}-range-requests-floor`, delta('rangeRequests'), Number(floor),
          'a scan that reached the provider zero times did not read the entry'));
      }
      return;
    }

    case 'traffic-window': {
      // WHAT A FIVE-MINUTE READ COST AT THE PROVIDER. The scan budgets do not apply: a playback legitimately
      // reads the object, so a fraction budget over it could not pass. What is bounded is AMPLIFICATION.
      const before = JSON.parse(readFileSync(need(args, 'before'), 'utf8')) as ProviderCounterSnapshot;
      const after = JSON.parse(readFileSync(need(args, 'after'), 'utf8')) as ProviderCounterSnapshot;
      const gate = need(args, 'gate');
      const objectBytes = optionalNumber(args, 'object-bytes', 1);
      const multiplier = optionalNumber(args, 'max-object-multiplier', 3);
      // THE DENOMINATOR CAN BE AN EVENT RATHER THAN THE WINDOW, AND FOR SEEKS IT MUST BE. A seek on Plex
      // restarts the encoder, and a restart re-opens the object — so "ten seeks cost at most six times the
      // object" is an arbitrary window multiple, while "one seek costs at most 1.2x the object" is a
      // statement about what a seek IS. Callers that measure a continuous window leave `events` at one and
      // nothing changes for them.
      const events = Math.max(1, optionalNumber(args, 'events', 1));
      const delta = (key: string): number => counterValue(after, key) - counterValue(before, key);

      // A SEEK WINDOW IS BUDGETED FROM BLOCK GEOMETRY, NOT FROM THE OBJECT'S SIZE. Each seek restarts the
      // encoder, and a restart is an open: up to three 4 MiB demand blocks, plus the session's setup reads.
      // `1.2 x object x 10` was both loose and unstable — on a small fixture it sat a hair above the
      // arithmetic floor, and on a large one it would have meant nothing.
      const seekBudget = args.flags.get('seek-ceiling') === 'true';
      for (const result of providerByteResults(gate, {
        committed: delta('bytesServed'),
        observed: delta('observedBytes'),
        truncatedBodies: delta('truncatedBodies'),
      }, seekBudget ? plexSeekByteCeiling(events) : Math.floor(objectBytes * multiplier * events),
      seekBudget
        ? `${events} seeks, each an encoder restart of at most `
          + `${PLEX_READ_GEOMETRY.DEMAND_BLOCKS_PER_OPEN} demand blocks of `
          + `${PLEX_READ_GEOMETRY.CHUNK_BYTES} bytes, plus one session setup allowance`
        : `denominator: the object's own ${objectBytes} bytes, read at most ${multiplier}x over the window`)) {
        record(args, result);
      }
      record(args, withinBudget(`${gate}-range-requests`, delta('rangeRequests'),
        optionalNumber(args, 'max-range-requests', 4096)));

      // THE FLOOR THAT USED TO BE HERE, AND WHY IT COULD NOT STAY.
      //
      // It read: `atLeast(range requests, 1)` — "a window in which the provider was never reached means the
      // bytes came from somewhere else". That inference was sound while a handle release DELETED the playback
      // cache, because then every playback window had to re-fetch. It is no longer sound. A release now
      // discharges the handle's admission and leaves the bytes addressable, so an object that fits in the
      // playback cache is served from memory on every later open — and gate10 measured exactly that: five
      // minutes of paced play, ten seeks and five minutes of transcode, all with a provider delta of ZERO,
      // while the decoders independently proved 300 s of playable output, ten distinct seek positions and
      // 332 s of transcoded output. The floor turned the repair's intended effect into three failures.
      //
      // WHAT REPLACES IT IS NOT A WEAKER FLOOR. Dropping it, as `--warm-capable` does for the scan windows in
      // PX12b, would accept ANY zero-provider window — including one where the media server read a stale
      // mount, or where something that is not the daemon answered. That is the exact ambiguity the floor
      // existed to catch, and it is still worth catching. So a zero-provider window must now prove POSITIVELY
      // that this daemon served it, from the daemon's own cumulative playback-cache counters over the same
      // window. Zero provider requests AND zero cache hits is still a failure, and it is the same failure the
      // old floor was aimed at.
      const providerRequests = delta('rangeRequests');
      if (providerRequests > 0) {
        // COLD, AND UNCHANGED. The window reached the provider, so the original floor is exactly right and is
        // asserted under its original name. Nothing about a cold run's verdicts moves.
        record(args, atLeast(`${gate}-range-requests-floor`, providerRequests,
          optionalNumber(args, 'min-range-requests', 1),
          'a window in which the provider was never reached means the bytes came from somewhere else'));
      } else if (providerRequests < 0) {
        // A PROVIDER COUNTER THAT FELL IS A BROKEN INSTRUMENT, NOT A WARM WINDOW.
        //
        // THE DEFECT THIS CLOSES. The branch was `> 0` and an else, so a NEGATIVE delta — the endpoint
        // restarted, or its counters were reset, between the two readings — landed in the warm arm and was
        // then decided entirely by the daemon's cache evidence. That evidence can be perfectly healthy while
        // the provider side of the window describes nothing at all, so a reset endpoint would have been
        // reported as "served from cache". "Fewer requests than we started with" is not proof that nothing
        // was fetched; it is proof that this window has no interval, which also makes every ceiling above it
        // meaningless. The warm arm is now reached on EXACTLY zero and nothing else.
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
        // THE HEADLINE, NAMED FOR THE ASSERTION IT REPLACES so a reader of two runs can see the substitution
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
      record(args, withinBudget(`${gate}-peak-connections`, counterValue(after, 'peakConns'),
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS));
      return;
    }

    case 'shape-window': {
      // EVIDENCE ONLY. This records the request shape over one counter window and asserts nothing but the
      // two partitions — no ceiling, no floor, no fraction, no budget of any kind.
      //
      // WHY IT IS A SEPARATE COMMAND RATHER THAN A FLAG ON `budget`. A flag that suppressed the budgets
      // would leave a `budget` call in the gate that scores nothing, which is exactly the shape of thing
      // somebody later reads as a passing budget. The command is named for what it does, and the geometry
      // diagnostic is the only caller.
      const before = JSON.parse(readFileSync(need(args, 'before'), 'utf8')) as ProviderCounterSnapshot;
      const after = JSON.parse(readFileSync(need(args, 'after'), 'utf8')) as ProviderCounterSnapshot;
      const gate = need(args, 'gate');
      const delta = (key: string): number => counterValue(after, key) - counterValue(before, key);

      const bucketedBytes = delta('chunkBytes') + delta('smallBytes')
        + delta('partialBytes') + delta('oversizedBytes');
      const bucketedRequests = delta('chunkResponses') + delta('smallResponses')
        + delta('partialResponses') + delta('oversizedResponses');
      record(args, {
        gate: `${gate}-request-shape`, verdict: 'pass',
        note: `${delta('chunkResponses')} responses of exactly one 4 MiB demand block `
          + `(${delta('chunkBytes')} bytes), ${delta('smallResponses')} of one probe window or less `
          + `(${delta('smallBytes')} bytes), ${delta('partialResponses')} clipped blocks `
          + `(${delta('partialBytes')} bytes), ${delta('oversizedResponses')} oversized `
          + `(${delta('oversizedBytes')} bytes); ${delta('rangeRequests')} ranged requests, `
          + `${delta('bytesServed')} bytes, ${delta('resolutions')} resolutions`,
      });
      // THE PARTITIONS STILL HOLD, because a shape nobody reconciled is a shape nobody can build on.
      record(args, exactly(`${gate}-request-shape-accounts-for-every-byte`,
        bucketedBytes, delta('bytesServed')));
      record(args, exactly(`${gate}-request-shape-accounts-for-every-request`,
        bucketedRequests + delta('bodylessResponses'), delta('accountedResponses')));
      return;
    }

    case 'assert-scan-in-flight': {
      // THE PRE-PUBLISH GUARD. The marker says the scan WAS running when another process looked; this asks
      // whether it still is, at the last possible moment before the successor is published.
      const state = readState(need(args, 'state'));
      if (!(await scanIsRunningNow(state))) {
        fail('the scan is no longer running, so a publish now would not be a mid-scan publish. '
          + 'Refusing rather than publishing and claiming otherwise.');
      }
      console.log('  the scanner is still in flight at the moment of publication');
      return;
    }

    case 'provider-invariants': {
      // ABSOLUTE, NOT A DELTA. Zero 429s for the WHOLE run is a much stronger claim than zero during a window.
      const snapshot = JSON.parse(readFileSync(need(args, 'counters'), 'utf8')) as ProviderCounterSnapshot;
      const gate = need(args, 'gate');
      record(args, withinBudget(`${gate}-http-429-total`, counterValue(snapshot, 'served429'),
        MEDIA_SERVER_BUDGETS.MAX_HTTP_429, 'across the whole run'));
      record(args, withinBudget(`${gate}-full-body-total`, counterValue(snapshot, 'fullBodyServed'),
        MEDIA_SERVER_BUDGETS.MAX_FULL_BODY_SERVED, 'across the whole run'));
      record(args, withinBudget(`${gate}-peak-connections-total`, counterValue(snapshot, 'peakConns'),
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS, 'across the whole run'));
      record(args, withinBudget(`${gate}-peak-concurrent-reads`, counterValue(snapshot, 'peakConcurrent'),
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS, 'across the whole run'));
      return;
    }

    case 'paced-play': {
      // FIVE MINUTES OF DIRECT PLAY, CONSUMED AT THE MEDIA'S OWN RATE by a decoder in another container.
      const state = readState(need(args, 'state'));
      const item = itemFor(readItems(need(args, 'items')), need(args, 'key'));
      const seconds = optionalNumber(args, 'seconds', MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS);
      const { path, hadCredential } = safePartPath(item);
      const outcome = await pacedDirectPlay({
        image: need(args, 'image'),
        network: need(args, 'network'),
        containerName: need(args, 'container-name'),
        workDir: need(args, 'work-dir'),
        streamUrl: `${need(args, 'stream-base')}${path}`,
        outputRelPath: need(args, 'output-rel'),
        seconds,
        ffmpegPath: need(args, 'ffmpeg'),
      });
      writeFileSync(need(args, 'trace'), `${JSON.stringify(outcome.samples, null, 2)}\n`);
      if (outcome.exitCode !== 0) {
        console.error(`  the consumer exited ${outcome.exitCode}: ${outcome.stderr}`);
      }
      record(args, exactly(`PX18-consumer-exit:${ref(item)}`, outcome.exitCode ?? -1, 0));
      record(args, exactly(`PX18-no-credential-on-command-line:${ref(item)}`, hadCredential ? 1 : 0, 0));

      const analysis = analysePacedPlayback(outcome.samples);
      record(args, atLeast(`PX18-progress-samples:${ref(item)}`, analysis.samples, 10,
        'a trace with no records cannot support any statement about how the play went'));
      record(args, withinBudget(`PX18-startup-seconds:${ref(item)}`,
        Math.round(analysis.startupSeconds * 100) / 100, MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS));
      record(args, atLeast(`PX18-wall-seconds:${ref(item)}`,
        Math.round(analysis.wallSeconds), seconds));
      // THE ONE THAT MAKES THE WALL CLOCK MEAN SOMETHING. Wall seconds alone are passed by a download and a
      // sleep; decoded media seconds are what a player actually produced.
      record(args, atLeast(`PX18-decoded-media-seconds:${ref(item)}`,
        Math.round(analysis.mediaSeconds), seconds));
      record(args, withinBudget(`PX18-pacing-ratio-ceiling:${ref(item)}`,
        Math.round(analysis.pacingRatio * 1000) / 1000, MEDIA_SERVER_SOAK.MAX_PACING_RATIO,
        'media seconds per wall second: a drain-and-sleep sits in the hundreds'));
      record(args, atLeast(`PX18-pacing-ratio-floor:${ref(item)}`,
        Math.round(analysis.pacingRatio * 1000) / 1000, MEDIA_SERVER_SOAK.MIN_PACING_RATIO,
        'and a sleep that decoded almost nothing sits near zero'));
      record(args, withinBudget(`PX18-longest-stall-seconds:${ref(item)}`,
        Math.round(analysis.longestStallSeconds * 100) / 100, MEDIA_SERVER_SOAK.MAX_STALL_SECONDS,
        'the "without a stall" half of G8, which start-and-end numbers cannot see at all'));
      return;
    }

    case 'paced-play-output': {
      // THE DECODER'S OWN VERDICT ON WHAT THE PACED CONSUMER WROTE, produced in another container.
      const seconds = optionalNumber(args, 'seconds', MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS);
      record(args, atLeast('PX18-output-media-seconds', optionalNumber(args, 'probed-seconds', 0),
        Math.floor(seconds * 0.95),
        're-probed end to end: "playable output" is a decoder\'s answer, not a byte count'));
      record(args, atLeast('PX18-output-packets', optionalNumber(args, 'probed-packets', 0), 1));
      return;
    }

    case 'media-seeks': {
      // TEN MEDIA-TIME SEEKS, performed the way an HLS client performs one.
      const state = readState(need(args, 'state'));
      const item = itemFor(readItems(need(args, 'items')), need(args, 'key'));
      const duration = optionalNumber(args, 'duration-seconds', item.durationSeconds);
      const planProblems = seekPlanProblems(SEEK_PLAN_FRACTIONS);
      for (const problem of planProblems) console.error(`  ${problem}`);
      record(args, exactly(`PX19-seek-plan-well-formed:${ref(item)}`, planProblems.length, 0,
        'ten distinct positions, at least three transitions backwards, at least one past 90%'));
      if (planProblems.length > 0) fail('the seek plan is not fit to be evidence');

      const positions = seekPositionsFor(duration);
      const outcome = await mediaTimeSeekSet(state, item, sessionId('seeks'), positions);
      const dir = need(args, 'segment-dir');
      mkdirSync(dir, { recursive: true });
      outcome.segments.forEach((body, index) => {
        writeFileSync(`${dir}/seek-${String(index).padStart(2, '0')}.ts`, Buffer.from(body));
      });
      writeFileSync(need(args, 'out'), `${JSON.stringify({
        seeks: outcome.seeks,
        playlistSeconds: outcome.playlistSeconds,
        positionErrorCeilingSeconds: outcome.positionErrorCeilingSeconds,
        durationSeconds: duration,
        warmupMs: outcome.warmupMs,
      }, null, 2)}\n`);
      // THE SESSION WARM-UP, UNDER ITS OWN NAME AND ITS OWN CEILING. A seek is a transition within an
      // established session; bringing the session up is playback startup, which G8 budgets and G9 does not
      // mention. It is asserted rather than merely recorded, so a session that took a minute to produce a
      // picture fails here instead of disappearing into the gap between two gates.
      record(args, withinBudget(`PX19-session-warmup-seconds:${ref(item)}`,
        Math.round((outcome.warmupMs / 1_000) * 100) / 100,
        MEDIA_SERVER_DEADLINES_MS.SEEK / 1_000,
        'bringing the encoder up and reading its first output, measured apart from the ten seeks'));
      record(args, exactly(`PX19-no-credential-in-generated-urls:${ref(item)}`,
        outcome.credentialsInGeneratedUrls, 0));
      record(args, exactly(`PX19-seeks-performed:${ref(item)}`, outcome.seeks.length,
        MEDIA_SERVER_SOAK.SEEK_COUNT));
      // THE PLAN IS CHECKED AGAINST THE MEDIA'S REAL DURATION, not against the deepest position it happened
      // to reach: two positions must be past 90 % of the file, and "the file" is what the server's own
      // playlist says it is.
      const deep = positions.filter((position) =>
        position > outcome.playlistSeconds * MEDIA_SERVER_SOAK.DEEP_SEEK_FRACTION).length;
      record(args, atLeast(`PX19-seeks-past-90-percent:${ref(item)}`, deep, 2,
        `against the ${Math.round(outcome.playlistSeconds)}s the server's own playlist describes`));
      return;
    }

    case 'seek-verify': {
      // THE SET-LEVEL PROPERTIES. Every per-seek assertion — a 200, a non-empty body, decodable h264, inside
      // ten seconds — is satisfied by a server that returned the first segment ten times over.
      const key = need(args, 'key');
      const handle = opaqueRef('entry', key).slice(0, 12);
      const seekFile = JSON.parse(readFileSync(need(args, 'seeks'), 'utf8')) as {
        seeks: Array<{
          index: number; requestedSeconds: number; serverPositionSeconds: number; elapsedMs: number;
          bytes: number; sha256: string;
        }>;
        playlistSeconds: number;
        positionErrorCeilingSeconds: number;
      };
      const decodes = JSON.parse(readFileSync(need(args, 'probes'), 'utf8')) as SeekDecode[];
      const analysis = analyseSeekSet(seekFile.seeks, decodes);

      // THE PER-SEEK PROFILE, RECORDED BEFORE ANY SET-LEVEL VERDICT. A failing "slowest seek" number with no
      // breakdown behind it is undiagnosable: it cannot say whether one position was pathological or the
      // whole set was slow, and the run directory is deleted on the way out. This costs one line and turns
      // the next failure into a fact. It carries no path, no locator and no address.
      record(args, {
        gate: `PX19-seek-elapsed-profile:${handle}`, verdict: 'pass',
        note: seekFile.seeks
          .map((seek) => `#${seek.index}@${Math.round(seek.serverPositionSeconds)}s=${seek.elapsedMs}ms`)
          .join(' '),
      });

      record(args, exactly(`PX19-seek-count:${handle}`, analysis.count, MEDIA_SERVER_SOAK.SEEK_COUNT));
      record(args, withinBudget(`PX19-slowest-seek-seconds:${handle}`,
        Math.round(analysis.slowestSeconds * 100) / 100, MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS));
      record(args, exactly(`PX19-distinct-segments:${handle}`, analysis.distinctSegments,
        MEDIA_SERVER_SOAK.SEEK_COUNT,
        'ten seeks that returned the same segment ten times are not ten seeks'));
      record(args, atLeast(`PX19-backward-transitions:${handle}`, analysis.backwardTransitions,
        MEDIA_SERVER_SOAK.MIN_BACKWARD_SEEKS));
      record(args, atLeast(`PX19-deep-seeks:${handle}`, analysis.deepSeeks, 2));
      record(args, exactly(`PX19-unprobed:${handle}`, analysis.unprobed, 0,
        'every segment was handed to a decoder; an unprobed one makes the rest a lower bound'));
      record(args, exactly(`PX19-wrong-codec:${handle}`, analysis.wrongCodec, 0));
      record(args, exactly(`PX19-empty-of-video:${handle}`, analysis.emptyOfVideo, 0));
      // THE POSITION CEILING IS THE SERVER'S OWN SEGMENT LENGTH, NOT A CONSTANT. Plex's segments are eight
      // seconds and Jellyfin's are three; the shared four-second constant is right for one of them and would
      // fail a correct seek against the other. Widening the shared constant to suit Plex would have quietly
      // slackened the Jellyfin gate.
      record(args, withinBudget(`PX19-max-position-error-seconds:${handle}`,
        Math.round(analysis.maxPositionErrorSeconds * 100) / 100,
        seekFile.positionErrorCeilingSeconds,
        'the ceiling is one segment as the server\'s own playlist declares it, plus a second'));
      // THE TEMPORAL ASSERTION. The offset between a decoded start timestamp and the position the server
      // said it was serving is one server's presentation-time convention — measured here, not hard-coded.
      // What is universal is that it does not change as the position moves.
      record(args, withinBudget(`PX19-decoded-offset-spread-seconds:${handle}`,
        Math.round(analysis.decodedOffsetSpreadSeconds * 100) / 100,
        MEDIA_SERVER_SOAK.MAX_SEEK_DECODED_OFFSET_SPREAD_SECONDS,
        'server presentation time measured against requested position, across all ten'));
      record(args, atLeast(`PX19-decoded-span-fraction:${handle}`,
        Math.round((analysis.decodedSpanSeconds / Math.max(1, seekFile.playlistSeconds)) * 1000) / 1000,
        MEDIA_SERVER_SOAK.MIN_SEEK_DECODED_SPAN_FRACTION));
      return;
    }

    case 'transcode-soak': {
      const state = readState(need(args, 'state'));
      const item = itemFor(readItems(need(args, 'items')), need(args, 'key'));
      const seconds = optionalNumber(args, 'seconds', MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS);
      const segmentDir = need(args, 'segment-dir');
      mkdirSync(segmentDir, { recursive: true });
      const outcome = await transcodeSoak(state, item, {
        seconds, segmentDir, session: sessionId('soak'),
      });
      writeFileSync(need(args, 'out'), `${JSON.stringify({
        segments: outcome.segments,
        encoderSamples: outcome.encoderSamples,
        failedSessionPolls: outcome.failedSessionPolls,
        credentialsInGeneratedUrls: outcome.credentialsInGeneratedUrls,
        playlistSeconds: outcome.playlistSeconds,
        sourceVideoCodec: outcome.sourceVideoCodec,
      }, null, 2)}\n`);
      console.log(`  consumed ${outcome.segments.length} segments over `
        + `${Math.round((outcome.segments[outcome.segments.length - 1]?.wallMs ?? 0) / 1000)}s`);
      return;
    }

    case 'transcode-soak-verify': {
      const key = need(args, 'key');
      const handle = opaqueRef('entry', key).slice(0, 12);
      const seconds = optionalNumber(args, 'seconds', MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS);
      const soak = JSON.parse(readFileSync(need(args, 'soak'), 'utf8')) as {
        segments: Array<{ index: number; wallMs: number; mediaStartSeconds: number; bytes: number; sha256: string }>;
        encoderSamples: Array<Record<string, unknown>>;
        failedSessionPolls: number;
        credentialsInGeneratedUrls: number;
        sourceVideoCodec: string;
      };
      const probes = JSON.parse(readFileSync(need(args, 'probes'), 'utf8')) as SoakProbe[];
      const producerDir = args.flags.get('producer-dir');
      const mtimes = producerDir === undefined
        ? [] : readProducerFiles(producerDir).map(([, mtime]) => mtime);

      const analysis = analyseTranscodeSoak(soak.segments, probes, mtimes, []);

      // THE SOURCE IS WHAT THE GATE ENCODED IT AS. A "transcode to h264" out of an h264 source proves
      // nothing, so this is asserted before anything about the output is looked at.
      record(args, {
        gate: `PX20-source-codec:${handle}`,
        verdict: soak.sourceVideoCodec === TRANSCODE_SOURCE_VIDEO_CODEC ? 'pass' : 'fail',
        note: `the media server identified the source as ${soak.sourceVideoCodec}`,
      });
      record(args, exactly(`PX20-no-credential-in-generated-urls:${handle}`,
        soak.credentialsInGeneratedUrls, 0));
      record(args, exactly(`PX20-unprobed-segments:${handle}`, analysis.unprobed, 0));
      record(args, exactly(`PX20-wrong-codec:${handle}`, analysis.wrongCodec, 0,
        'every consumed segment decoded as h264 by a decoder that is not Plex'));
      record(args, exactly(`PX20-empty-of-video:${handle}`, analysis.emptyOfVideo, 0));
      record(args, exactly(`PX20-distinct-segments:${handle}`, analysis.distinctSegments,
        analysis.segments, 'one segment delivered fifty times satisfies every other row here'));
      record(args, atLeast(`PX20-decoded-media-seconds:${handle}`,
        Math.round(analysis.decodedMediaSeconds), seconds));
      record(args, atLeast(`PX20-wall-span-seconds:${handle}`,
        Math.round(analysis.wallSpanSeconds), seconds));
      record(args, withinBudget(`PX20-max-arrival-gap-seconds:${handle}`,
        Math.round(analysis.maxArrivalGapSeconds * 100) / 100,
        MEDIA_SERVER_SOAK.MAX_SEGMENT_ARRIVAL_GAP_SECONDS,
        'the continuity assertion: consuming everything in ten seconds and sleeping cannot pass'));
      record(args, atLeast(`PX20-late-window-decoded-seconds:${handle}`,
        Math.round(analysis.lateWindowDecodedSeconds),
        Math.floor(seconds * MEDIA_SERVER_SOAK.MIN_LATE_WINDOW_DECODED_FRACTION),
        'the end of the window looks like the middle; a dense start with a padded tail cannot pass'));

      // THE ENCODER, WHICH ON PLEX CAN ACTUALLY BE MEASURED.
      //
      // The Jellyfin gate records encoder lifetime and asserts nothing about it, because its encoder
      // finishes a five-minute source in 1.6 seconds. Plex throttles against the client's consumption, so
      // its job stays alive and keeps producing across the window — and the floors below sit well under what
      // was measured, because a threshold pinned to an observed value fails on a loaded machine.
      const liveness = analysePlexEncoderLiveness(soak.encoderSamples as never);
      record(args, exactly(`PX20-failed-session-polls:${handle}`, soak.failedSessionPolls, 0,
        'a poll that failed is not the server reporting an absent session'));
      record(args, atLeast(`PX20-encoder-session-present:${handle}`,
        Math.round((liveness.presentSamples / Math.max(1, liveness.samples)) * 1000) / 1000,
        MEDIA_SERVER_SOAK.MIN_SESSION_PRESENT_SAMPLE_FRACTION,
        'without a session the numbers below are an absence dressed as a measurement'));
      record(args, atLeast(`PX20-encoder-output-advances:${handle}`, liveness.advances,
        PLEX_ENCODER_FLOORS.MIN_OFFSET_ADVANCES,
        'distinct moments at which the encoder had produced NEW output'));
      record(args, atLeast(`PX20-encoder-working-span-seconds:${handle}`,
        Math.round(liveness.workingSpanSeconds), PLEX_ENCODER_FLOORS.MIN_WORKING_SPAN_SECONDS,
        'wall seconds between the first and last of those moments'));
      record(args, atLeast(`PX20-encoder-throttled-samples:${handle}`, liveness.throttledSamples,
        PLEX_ENCODER_FLOORS.MIN_THROTTLED_SAMPLES,
        'the encoder was held back by the client\'s pace, which an encoder that raced to the end and '
        + 'exited cannot show'));
      // RECORDED, ASSERTED BY NOTHING. Server bookkeeping. It agrees with the decoded output here, and if it
      // ever stopped agreeing the decoded output is what this gate would believe.
      record(args, {
        gate: `PX20-server-telemetry-recorded:${handle}`, verdict: 'pass',
        note: `${liveness.samples} samples, ${liveness.liveSamples} with an incomplete job, `
          + `${liveness.transcodeDecisionSamples} calling the decision a transcode, `
          + `${liveness.sourceCodecSamples} naming the source ${TRANSCODE_SOURCE_VIDEO_CODEC}, `
          + `${liveness.targetCodecSamples} naming the output ${TRANSCODE_TARGET_VIDEO_CODEC}, `
          + `${Math.round(liveness.producedSpanSeconds)}s of output produced across the window`,
      });
      record(args, {
        gate: `PX20-encoder-files-recorded:${handle}`, verdict: 'pass',
        note: `${analysis.encoderOutputFiles} encoder output files spanning `
          + `${Math.round(analysis.encoderAheadSpanSeconds)}s: how far AHEAD of the paced client the encoder `
          + 'ran, not how long it ran',
      });
      return;
    }

    case 'redaction-check': {
      // THE ARTIFACT'S FORMAT DECIDES HOW IT IS READ, NOT ITS FILE EXTENSION.
      //
      // THE DEFECT THIS CLOSES. This used to pick `JSON.parse` for anything ending in `.json`. The results
      // artifact is `results.json` and is NDJSON — one `GateResult` per line, appended by `appendResult` as
      // each phase records a verdict — so the check threw `Unexpected non-whitespace character after JSON at
      // position 141` at the very end of a run that had otherwise produced 272 passing assertions. The
      // redaction check is the last thing standing between a report and whatever it might leak, and it was
      // deciding how to parse its subject by looking at the subject's NAME.
      //
      // `readResults` is the reader that matches the writer, and it is the only one used here.
      const path = need(args, 'file');
      if (!existsSync(path)) fail(`${path.split(/[/\\]/).pop()} does not exist`);
      const results = readResults(path);
      if (results.length === 0) fail('the results artifact is empty, so the check would have no subject');
      const problems = findRedactionProblems(results);
      if (problems.length > 0) {
        for (const problem of problems.slice(0, 20)) console.error(`  ${problem.kind} at ${problem.at}`);
        fail('a kept artifact is not redaction-safe');
      }
      console.log('  redaction-safe');
      return;
    }

    case 'report': {
      const results = readResults(need(args, 'results'));
      if (results.length === 0) fail('there are no results to report, which is itself a failure');
      const failed = results.filter((result) => result.verdict === 'fail');
      const skipped = results.filter((result) => result.verdict === 'skip');

      const problems = findRedactionProblems(results);
      if (problems.length > 0) {
        console.error('the gate report would have leaked:');
        for (const problem of problems.slice(0, 20)) console.error(`  ${problem.kind} at ${problem.at}`);
        fail('the report is not redaction-safe');
      }

      console.log('');
      console.log(`Projection Phase 1 — PLEX data plane: ${results.length} assertions, `
        + `${failed.length} failed, ${skipped.length} skipped.`);
      for (const result of results) {
        const measured = result.measured === undefined ? '' : ` ${result.measured}/${result.budget}`;
        console.log(`  ${result.verdict.padEnd(4)} ${result.gate}${measured}`);
      }
      const jsonOut = args.flags.get('json');
      if (jsonOut !== undefined) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
      // A SKIP IS NOT A PASS HERE EITHER. A run with a skipped assertion in it has not proved what its gate
      // id says, and the wrapper counts completed runs rather than zero exits.
      if (failed.length > 0) process.exit(1);
      if (skipped.length > 0) process.exit(1);
      return;
    }

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

// A PHASE THAT ENDS WITHOUT SAYING SO IS A FAILURE, NOT A PASS.
//
// The keepalive holds the event loop open for as long as a phase is running, so an idle await cannot let Node
// exit silently with status 0; and the flag makes an exit that happens anyway carry a non-zero status and a
// message, instead of an empty stdout the caller reads as "that phase passed".
let finished = false;
const keepalive = setInterval(() => undefined, 1_000);
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('projection-plex-dataplane: the phase exited without completing');
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
