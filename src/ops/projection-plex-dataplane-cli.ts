import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MEDIA_SERVER_BUDGETS, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_SOAK, SEEK_PLAN_FRACTIONS,
  TRANSCODE_SOURCE_VIDEO_CODEC, TRANSCODE_TARGET_VIDEO_CODEC, analysePacedPlayback, analyseSeekSet,
  analyseTranscodeSoak, atLeast, corpusProblems, corpusSelfProblems, exactly, findRedactionProblems,
  opaqueRef, seekPlanProblems, seekPositionsFor, withinBudget,
  type GateResult, type SeekDecode, type SoakProbe,
} from '../core/projection/media-server-dataplane.js';
import {
  PLEX_ENCODER_FLOORS, PLEX_LARGE_FIXTURE, PLEX_READ_GEOMETRY, analysePlexEncoderLiveness,
  plexScanByteCeiling, plexSeekByteCeiling,
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
//   budget        --before F --after F --gate G --entries N --bytes N [--small-bytes N] [--windows N]
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
      const snapshot = await response.json() as Record<string, number>;
      writeFileSync(need(args, 'out'), `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(`  provider counters: ${JSON.stringify(snapshot)}`);
      return;
    }

    case 'budget': {
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
      // WHAT A PLEX SCAN MAY COST, DERIVED FROM BLOCK GEOMETRY RATHER THAN FROM A MULTIPLE OF THE FIXTURE.
      //
      // The daemon serves a 4 MiB demand block for a one-byte read; Plex opens each new item twice and
      // touches about three blocks per open. So scanning ONE object costs up to `2 x 3 x 4 MiB`, clamped by
      // the object — a FIXED window, independent of size. On fixtures smaller than that window "reads a
      // fraction of the object" is not a property a correct implementation can have, and the earlier
      // attempt to express this as a >1.0 multiplier was recording the observation rather than budgeting it.
      // The product's fraction claim is asserted separately, against an object several times larger than
      // the window: `--large-bytes`. See `plexScanByteCeiling` and `PLEX_LARGE_FIXTURE`.
      // EVERY BYTE TERM COMES FROM `--object-sizes`, ONE OBJECT AT A TIME. `--bytes` and `--small-bytes`
      // survive only for the range/resolution denominators above; nothing about the byte budget is derived
      // from a pooled total any more, because a pooled total is what let one large object pay for
      // thirty-eight tiny ones.
      const sizes = (args.flags.get('object-sizes') ?? '').split(',')
        .map((entry) => Number(entry.trim())).filter((entry) => Number.isFinite(entry) && entry > 0);
      if (sizes.length > 0) {
        const byteBudget = plexScanByteCeiling(sizes);
        record(args, withinBudget(`${gate}-provider-bytes`, delta('bytesServed'), byteBudget,
          `${sizes.length} remote objects, each at most `
          + `${PLEX_READ_GEOMETRY.OPENS_PER_NEW_ITEM} opens x `
          + `${PLEX_READ_GEOMETRY.DEMAND_BLOCKS_PER_OPEN} demand blocks of `
          + `${PLEX_READ_GEOMETRY.CHUNK_BYTES} bytes, clamped by the object`));
        // A FLOOR, DERIVED PER OBJECT AND NOT CROSS-SUBSIDISED.
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
        const floorBytes = sizes.reduce(
          (total, size) => total + Math.min(size, PLEX_READ_GEOMETRY.PROBE_WINDOW_BYTES), 0,
        );
        record(args, atLeast(`${gate}-provider-bytes-floor`, delta('bytesServed'), floorBytes,
          'one probe window per object, or the object itself when it is smaller than a window; a scan that '
          + 'read less than that did not open the entries'));
      }
      // THE PRODUCT'S OWN CLAIM, ASSERTED WHERE IT IS MEANINGFUL. Against an object several times larger
      // than the fixed scan window, a scanner that downloaded it to identify it sits at 1.0 and the daemon
      // must sit well under. This uses the SHARED fraction, not one of Plex's own.
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
      record(args, withinBudget(`${gate}-peak-connections`, after.peakConns ?? 0,
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
      const before = JSON.parse(readFileSync(need(args, 'before'), 'utf8')) as Record<string, number>;
      const after = JSON.parse(readFileSync(need(args, 'after'), 'utf8')) as Record<string, number>;
      const gate = need(args, 'gate');
      const objectBytes = optionalNumber(args, 'object-bytes', 1);
      const multiplier = optionalNumber(args, 'max-object-multiplier', 3);
      // THE DENOMINATOR CAN BE AN EVENT RATHER THAN THE WINDOW, AND FOR SEEKS IT MUST BE. A seek on Plex
      // restarts the encoder, and a restart re-opens the object — so "ten seeks cost at most six times the
      // object" is an arbitrary window multiple, while "one seek costs at most 1.2x the object" is a
      // statement about what a seek IS. Callers that measure a continuous window leave `events` at one and
      // nothing changes for them.
      const events = Math.max(1, optionalNumber(args, 'events', 1));
      const delta = (key: string): number => (after[key] ?? 0) - (before[key] ?? 0);

      // A SEEK WINDOW IS BUDGETED FROM BLOCK GEOMETRY, NOT FROM THE OBJECT'S SIZE. Each seek restarts the
      // encoder, and a restart is an open: up to three 4 MiB demand blocks, plus the session's setup reads.
      // `1.2 x object x 10` was both loose and unstable — on a small fixture it sat a hair above the
      // arithmetic floor, and on a large one it would have meant nothing.
      const seekBudget = args.flags.get('seek-ceiling') === 'true';
      record(args, withinBudget(`${gate}-provider-bytes`, delta('bytesServed'),
        seekBudget ? plexSeekByteCeiling(events) : Math.floor(objectBytes * multiplier * events),
        seekBudget
          ? `${events} seeks, each an encoder restart of at most `
            + `${PLEX_READ_GEOMETRY.DEMAND_BLOCKS_PER_OPEN} demand blocks of `
            + `${PLEX_READ_GEOMETRY.CHUNK_BYTES} bytes, plus one session setup allowance`
          : `denominator: the object's own ${objectBytes} bytes, read at most ${multiplier}x over the window`));
      record(args, withinBudget(`${gate}-range-requests`, delta('rangeRequests'),
        optionalNumber(args, 'max-range-requests', 4096)));
      record(args, atLeast(`${gate}-range-requests-floor`, delta('rangeRequests'),
        optionalNumber(args, 'min-range-requests', 1),
        'a window in which the provider was never reached means the bytes came from somewhere else'));
      record(args, withinBudget(`${gate}-http-429`, delta('served429'), MEDIA_SERVER_BUDGETS.MAX_HTTP_429));
      record(args, withinBudget(`${gate}-full-body-on-range`, delta('fullBodyServed'),
        MEDIA_SERVER_BUDGETS.MAX_FULL_BODY_SERVED));
      record(args, withinBudget(`${gate}-peak-connections`, after.peakConns ?? 0,
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS));
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
