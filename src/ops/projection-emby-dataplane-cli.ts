import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MEDIA_SERVER_BUDGETS, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_SOAK, SEEK_PLAN_FRACTIONS,
  TRANSCODE_SOURCE_VIDEO_CODEC, TRANSCODE_TARGET_VIDEO_CODEC, analysePacedPlayback, analyseTranscodeSoak,
  analyseSeekSet, atLeast, corpusProblems, corpusSelfProblems, exactly, findRedactionProblems, opaqueRef,
  seekPlanProblems, seekPositionsFor, withinBudget,
  type CorpusExpectation, type GateResult, type SeekObservation, type SoakProbe, type SoakSegment,
  type TranscodeSessionSampleRecord,
} from '../core/projection/media-server-dataplane.js';
import { objectAttribution, scanByteResults } from '../core/projection/daemon-read-geometry.js';
import { providerByteResults } from '../core/projection/media-server-dataplane.js';
import {
  EMBY_CONSUMER_TOKEN_FILE, EMBY_PINNED_VERSION, EMBY_TRANSCODING_TEMP_PATH,
  PACED_PLAY_DECODE_MARGIN_SECONDS,
  embyAnonymousPlaybackIsRefused, embyConsumerExposureProblems, embyOrdinaryFileProblems, isEmbyItemId,
  redactionSafeVersion,
} from '../core/projection/emby-dataplane.js';
import {
  GateFailure, acceptsJellyfinAuthHeaderSpelling, addMovieLibrary, anonymousDirectPlayStatus, appendResult,
  awaitFile, awaitServer, bootstrap, directPlay, forcedTranscode, listMovies, mediaTimeSeekSet,
  openPinnedStream, pacedDirectPlay, rangeRead, readExpected, readResults, readState, resolveLibraryId,
  scanIsRunningNow, scanLibrary, transcodeSoak, writeState, type GateState, type ItemRecord,
} from './projection-emby-dataplane.js';

// The Projection Phase 1 EMBY data-plane gate, from the command line.
//
// IT IS A SEQUENCE OF PHASES RATHER THAN ONE RUN, because several of the gates are about what happens to a
// media server WHILE something else is done to the daemon underneath it — a successor published mid-stream, a
// SIGKILL mid-playback, a provider held mid-scan — and the something else is a publisher command and a
// `docker kill`. A single self-contained run would have had to learn to drive Docker and PostgreSQL, and the
// interesting half of the gate would then be a mock of the shell script it replaced.
//
// EVERY PHASE APPENDS ITS VERDICTS to one results file, and `report` prints them, checks them against the
// acceptance plan's redaction rule, and exits non-zero if any gate failed.
//
//   bootstrap    --state F --base URL                      stand the server up through its own first-run API
//   library      --state F --mount-path P --name N         add the projected mount as a Movies library
//   scan         --state F --expect-file F --out F [--label L] [--tolerant true] [--running-marker F]
//   play         --state F --items F --key K --expect-file F
//   anonymous-play --state F --items F --key K             THE NEGATIVE CONTROL EMBY MAKES POSSIBLE
//   seek         --state F --items F --key K --offset N --length N --expect-sha S
//   transcode    --state F --items F --key K --out-segment F
//   hold-stream  --state F --items F --key K --ready F --release F --expect-file F [--allow-interrupt true]
//   resume       --state F --items F --key K --expect-file F
//   compare      --before F --after F --gate G [--expect-added N]
//   counters     --url U --out F
//   budget       --before F --after F --gate G --entries N --bytes N [--small-bytes N] [--windows N]
//   traffic-window --before F --after F --gate G --object-bytes N [--max-object-multiplier N]
//   provider-invariants --counters F --gate G
//   assert-scan-in-flight --state F
//   report       --results F [--json F]        redaction-check --file F
//
// ...and the five-minute half, where G8, G9 and G10 of the acceptance plan actually live:
//
//   corpus-check --expect-file F --min-entries N --min-remote N
//   encoder-observability --producer-dir D     records finding 3 rather than configuring a path
//   paced-play   --state F --items F --key K --image I --network N --container-name C
//                --work-dir D --local-work-dir D --stream-base U --output-rel P --ffmpeg P --trace F
//                [--seconds N]      (--work-dir is Docker's spelling, --local-work-dir is this process's)
//   paced-play-output  --probed-seconds N --probed-packets N [--seconds N]
//   media-seeks  --state F --items F --key K --duration-seconds N --segment-dir D --out F
//   seek-verify  --key K --seeks F --probes F
//   transcode-soak        --state F --items F --key K --segment-dir D --producer-dir D --out F [--seconds N]
//   transcode-soak-verify --key K --items F --soak F --probes F [--seconds N]
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
  console.error(`projection-emby-dataplane: ${message}`);
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
 * One counter, refused rather than coerced when it is not a whole non-negative count.
 *
 * A `NaN` propagating out of a malformed counters file makes every budget below it fail, and the failure
 * blames the data plane for a broken instrument. Naming it here means the instrument is what fails.
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
 * WHY THIS EXISTS AT ALL, AND IT IS INHERITED FROM THE PLEX GATE RATHER THAN INVENTED HERE. Since a handle
 * release stopped deleting playback entries, a window of real playback can legitimately reach the provider
 * ZERO times — the bytes are already in the daemon's memory. "Zero provider requests" then has two
 * explanations that demand opposite responses: the daemon served it, or something that is not the daemon did.
 * The provider's counters cannot tell them apart, because the distinguishing evidence is on the other side.
 *
 * A FLOOR OF ONE PROVIDER REQUEST USED TO SIT HERE AND WAS WRONG. It encoded the inference "never reached the
 * provider means the bytes came from somewhere else", which a daemon repair made false; three windows of real
 * playback measured zero while independent decoders proved 300 s of output. The floor was not dropped — it
 * was replaced by this, which requires the daemon to account for the window instead.
 *
 * WHAT IT REFUSES, AND WHY NONE OF THE REFUSALS IS PEDANTRY.
 *   ABSENT SNAPSHOTS. A caller that measured no daemon evidence has proved nothing about a zero window and
 *   must not be quietly the same as one that measured evidence and found it.
 *   A MISSING `playback` OBJECT. A daemon too old to publish these counters reads as all-zero through a
 *   forgiving parser, which is indistinguishable from a daemon that served nothing. It is named as absent.
 *   A NEGATIVE DELTA. Cumulative counters only rise within one process. A drop means the daemon RESTARTED
 *   inside the window, so the two readings describe different processes and their difference describes
 *   neither. This is the failure mode a warm-cache claim is most exposed to, because this gate restarts the
 *   daemon on purpose elsewhere in the same run.
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

/**
 * The claim the whole appliance rests on, as one predicate: a media server sees a file on a disk.
 *
 * IT DELEGATES TO THE PURE MODULE, which returns REASONS rather than a boolean, so a failure names what went
 * wrong. `Protocol=Http` means the server decided to fetch the media itself; a `Placeholder` media source
 * means it catalogued an item it never opened; an empty container means it never successfully probed the
 * file. Those are three different failures of this product and they must not arrive as the same word.
 *
 * IT PASSES EMBY'S OWN FIELDS, NOT JELLYFIN'S. This server sends no `LocationType` at all — see
 * `EMBY_ITEMS_OMIT_LOCATION_TYPE` — and the predicate that inherited it matched zero of two correctly
 * catalogued entries on the first complete run of this gate.
 */
function ordinaryFileProblems(item: ItemRecord): string[] {
  return embyOrdinaryFileProblems({
    key: item.key,
    protocol: item.protocol,
    container: item.container,
    isRemote: item.isRemote,
    supportsDirectPlay: item.supportsDirectPlay,
    mediaSourceType: item.mediaSourceType,
    path: item.path,
    mediaSourcePath: item.mediaSourcePath,
  });
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
      //
      // A RE-BOOTSTRAP AFTER A SERVER RESTART IS THE SAME INSTALLATION. On Emby the wizard's completion is not
      // published as a flag anywhere (finding 1), so `bootstrap` probes the wizard endpoint's own access
      // control instead — 200 unauthenticated means open, 401 means complete. Getting this wrong would mean
      // re-running the wizard over the very installation the restart phase exists to prove survived.
      const statePath = need(args, 'state');
      const previous = existsSync(statePath) ? readState(statePath) : undefined;
      const state: GateState = { baseUrl: need(args, 'base') };
      if (previous?.libraryId !== undefined) state.libraryId = previous.libraryId;
      if (previous?.libraryName !== undefined) state.libraryName = previous.libraryName;
      const version = await awaitServer(state);
      console.log(`  the media server answered; version ${version}`);
      // ONE PASSWORD PER STATE FILE, derived rather than random, so a re-bootstrap after a restart can log in
      // to the account the first one created. A fresh random each time would create an account the second
      // invocation could not authenticate against, and the failure would look like "the restart lost the user".
      const password = `g${opaqueRef('password', statePath)}`;
      const ranWizard = await bootstrap(state, 'projection-gate', password);
      writeState(statePath, state);
      if (!existsSync(statePath)) fail('the bootstrap wrote no state file');

      // THE VERSION IS RENDERED WITH HYPHENS, and that is a redaction requirement rather than a style. §7
      // forbids an IP address in a report, and `4.9.5.0` matches the four-dotted-groups pattern that enforces
      // it exactly — so a note carrying the raw version would make the report be refused at the end of a
      // half-hour run, after every assertion had already passed. See `redactionSafeVersion`.
      const shownVersion = redactionSafeVersion(version);
      record(args, { gate: 'EM1-bootstrap', verdict: 'pass', note: `server version ${shownVersion}` });
      // THE PINNED VERSION IS ASSERTED, because every measured finding in
      // `src/core/projection/emby-dataplane.ts` belongs to one version. A gate whose recorded behaviour
      // belongs to a version it is no longer running reads like evidence and is not.
      record(args, {
        gate: 'EM1-pinned-version',
        verdict: version === EMBY_PINNED_VERSION ? 'pass' : 'fail',
        note: `the measured findings in emby-dataplane.ts were taken against `
          + `${redactionSafeVersion(EMBY_PINNED_VERSION)}; this server reports ${shownVersion}. If the digest `
          + 'was deliberately moved, re-measure the findings and update the constant rather than widening '
          + 'this check',
      });
      // WHICH HALF OF THE BOOTSTRAP RAN, recorded so a reader can tell an installation from a login.
      record(args, {
        gate: 'EM1-wizard-ran', verdict: 'pass',
        note: ranWizard
          ? 'the first-run wizard was open and was completed non-interactively through the server\'s own API'
          : 'the wizard was already complete, so this was an ordinary login against the same installation',
      });
      // A COMPATIBILITY OBSERVATION, RECORDED AND ASSERTED ON BY NOTHING. This gate sends Emby's own
      // `X-Emby-Authorization` everywhere; that the fork's `Authorization` spelling also works is worth
      // dating, because the day it stops is the day a Jellyfin-shaped driver breaks against Emby.
      const alsoAcceptsPlain = await acceptsJellyfinAuthHeaderSpelling(state, 'projection-gate', password);
      record(args, {
        gate: 'EM1-auth-header-compatibility', verdict: 'pass',
        note: `this server ${alsoAcceptsPlain ? 'also accepts' : 'no longer accepts'} the MediaBrowser scheme `
          + 'under the plain Authorization header. RECORDED, NOT ASSERTED: the gate sends X-Emby-Authorization, '
          + 'which is this server\'s own spelling, so neither answer changes what was proved',
      });
      return;
    }

    case 'library': {
      const state = readState(need(args, 'state'));
      await addMovieLibrary(state, need(args, 'mount-path'), need(args, 'name'));
      writeState(need(args, 'state'), state);
      record(args, {
        gate: 'EM2-library', verdict: 'pass',
        note: 'the library exists and points at the projected mount, with every internet metadata fetcher off',
      });
      return;
    }

    case 'scan': {
      const state = readState(need(args, 'state'));
      const expected = readExpected(need(args, 'expect-file'));
      // THE SYNCHRONISATION POINT FOR THE MID-SCAN GATE. When asked for, this file is written the moment the
      // scanner is observed IN FLIGHT — not after a sleep. The publishing half waits on it, so "a generation
      // was admitted while a scan was running" is an observation rather than a hope.
      const runningMarker = args.flags.get('running-marker');
      const outcome = await scanLibrary(state, runningMarker === undefined ? undefined : () => {
        mkdirSync(runningMarker.replace(/[^/\\]*$/, '') || '.', { recursive: true });
        writeFileSync(runningMarker, 'running\n');
      });
      const elapsed = outcome.elapsedMs;
      await resolveLibraryId(state);
      writeState(need(args, 'state'), state);
      const items = await listMovies(state);
      writeFileSync(need(args, 'out'), `${JSON.stringify(items, null, 2)}\n`);
      const label = args.flags.get('label') ?? 'scan';

      // A TOLERANT SCAN IS ONE THE GATE DELIBERATELY RACED. When a successor is published WHILE a scan is
      // running, the scan may legitimately have seen the predecessor's namespace, the successor's, or a
      // mixture — and asserting a count against any of them would be asserting the outcome of a race. What
      // must hold is checked by the STRICT scan that follows: it converges, with zero removals and zero
      // item-id churn for everything carried.
      if (args.flags.get('tolerant') === 'true') {
        record(args, {
          gate: `EM3-${label}-scan-observed-in-flight`,
          verdict: outcome.observedInFlight ? 'pass' : 'fail',
          note: 'the scanner was seen actually running; a fast-complete between polls would not count',
        });
        record(args, {
          gate: `EM3-${label}-raced-scan-completed`, verdict: 'pass',
          note: `a scan raced against a publish completed in ${Math.round(elapsed / 1000)}s and returned a `
            + `well-formed listing of ${items.length}; what it saw is not asserted, and the next scan is`,
        });
        for (const item of items) {
          record(args, {
            gate: `EM3-${label}-raced-item-coherent:${opaqueRef('entry', item.key).slice(0, 12)}`,
            verdict: item.sizeBytes > 0 && item.protocol === 'File' && !item.isRemote ? 'pass' : 'fail',
            note: 'a mid-scan generation change must not produce a half-formed item',
          });
        }
        return;
      }

      record(args, exactly(`EM3-${label}-item-count`, items.length, expected.length,
        `the scan took ${Math.round(elapsed / 1000)}s`));

      // THE WHOLE CORPUS, IN ONE PASS, AS A COUNT OF MATCHED IDENTITIES.
      //
      // WHY IT IS AGGREGATE: fifty entries times four properties times seven scans is fourteen hundred report
      // lines, and a report nobody reads hides a regression as well as a silent one does.
      //
      // WHY IT IS STILL NOT A COUNT: `matched` counts PUBLISHED keys that were present, at the published size,
      // as ordinary files — so `50/50` cannot be satisfied by fifty arbitrary items the way an item count can.
      const problems = corpusProblems(expected, items.map((item) => ({
        key: item.key,
        sizeBytes: item.sizeBytes,
        ordinaryFile: ordinaryFileProblems(item).length === 0,
      })));
      // THE HEADLINE COUNT CARRIES THE FIRST REASONS WITH IT, and that is a repair rather than a flourish.
      // The first complete run of this gate failed exactly here, `measured=0 budget=2`, with no indication of
      // which property was wrong — and the cause was one field this server does not send. A count with no
      // diagnosis costs a whole half-hour run to interpret.
      const whyNotOrdinary = items
        .flatMap((item) => ordinaryFileProblems(item))
        .filter((reason, index, all) => all.indexOf(reason) === index)
        .slice(0, 3);
      record(args, exactly(`EM3-${label}-corpus-matched`, problems.matched, expected.length,
        problems.matched === expected.length
          ? 'published identities the server catalogued at the published size as ordinary files'
          : `published identities catalogued at the published size as ordinary files. Of what was NOT `
            + `matched: ${problems.missing} missing, ${problems.wrongSize} at the wrong size, `
            + `${problems.notOrdinary} not ordinary${whyNotOrdinary.length > 0
              ? ` (${whyNotOrdinary.join('; ')})` : ''}`));
      record(args, exactly(`EM3-${label}-corpus-missing`, problems.missing, 0));
      record(args, exactly(`EM3-${label}-corpus-wrong-size`, problems.wrongSize, 0));
      record(args, exactly(`EM3-${label}-corpus-not-ordinary`, problems.notOrdinary, 0,
        'not a symlink, not a .strm placeholder, not a remote media source: a file on a disk'));
      record(args, exactly(`EM3-${label}-corpus-duplicated`, problems.duplicated, 0));
      record(args, exactly(`EM3-${label}-corpus-unexpected`, problems.unexpected, 0));

      // EMBY'S OWN IDENTIFIER SHAPE, checked once per scan. It is not a churn assertion — that is `compare` —
      // it is a check that the ids this gate is comparing are the kind of id that was measured. See
      // `EMBY_ITEM_IDS_ARE_DATABASE_ROW_IDS` for what a stable Emby id does and does not corroborate.
      record(args, exactly(`EM3-${label}-item-id-shape`,
        items.filter((item) => !isEmbyItemId(item.itemId)).length, 0,
        'every item id is the decimal row id this server was measured to mint'));

      // AND THE ANCHORS INDIVIDUALLY. These are the entries whose BYTES are also read back and digest-compared
      // elsewhere; naming them one at a time keeps the per-entry evidence for the entries that have it.
      for (const want of expected.filter((entry) => entry.anchor === true)) {
        const item = itemFor(items, want.key);
        record(args, exactly(`EM3-${label}-size:${opaqueRef('entry', want.key).slice(0, 12)}`,
          item.sizeBytes, want.sizeBytes));
        const reasons = ordinaryFileProblems(item);
        record(args, {
          gate: `EM3-${label}-ordinary-file:${opaqueRef('entry', want.key).slice(0, 12)}`,
          verdict: reasons.length === 0 ? 'pass' : 'fail',
          note: reasons.length === 0
            ? `protocol=${item.protocol} container=${item.container} sourceType=${item.mediaSourceType} `
              + `remote=${item.isRemote} directPlay=${item.supportsDirectPlay}`
            : reasons.join('; '),
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
      record(args, exactly(`EM4-direct-play-bytes:${opaqueRef('entry', key).slice(0, 12)}`,
        result.bytes, want.sizeBytes));
      record(args, {
        gate: `EM4-direct-play-digest:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: result.sha256 === want.sha256 ? 'pass' : 'fail',
        note: `${want.kind} source; digest recorded outside the mount`,
      });
      return;
    }

    case 'anonymous-play': {
      // THE NEGATIVE CONTROL THIS SERVER MAKES POSSIBLE AND JELLYFIN DOES NOT.
      //
      // The pinned Jellyfin answers `static=true` direct play **200 with the whole file** to a request
      // carrying no credential at all, which is why that gate states plainly that its direct-play evidence is
      // about BYTES and not about authorization. The pinned Emby answers the identical request **401**.
      //
      // SO THIS GATE ASSERTS THE REFUSAL. It is a claim the Jellyfin gate had to decline to make, it is made
      // by actually issuing the unauthorized request, and a 200 here would be a real regression in the media
      // server that this gate is in a position to notice. It is not a weakening of anything: the authenticated
      // direct-play digest assertions stand exactly as they do on the other two servers, and this is evidence
      // in addition to them.
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const item = itemFor(items, key);
      const status = await anonymousDirectPlayStatus(state, item);
      record(args, {
        gate: `EM4b-anonymous-direct-play-refused:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: embyAnonymousPlaybackIsRefused(status) ? 'pass' : 'fail',
        measured: status, budget: 401,
        note: 'the identical direct-play request with NO credential. A 200 would mean this server had started '
          + 'serving media to unauthenticated callers; anything that is neither a refusal nor a serve means '
          + 'the control measured nothing. The pinned Jellyfin answers this 200, which is why only the Emby '
          + 'gate can assert it',
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
      record(args, exactly(`EM5-seek-206-bytes:${opaqueRef('entry', key).slice(0, 12)}`, result.bytes, length,
        'Content-Range asserted before the body was read'));
      record(args, {
        gate: `EM5-seek-digest:${opaqueRef('entry', key).slice(0, 12)}`,
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
      // let the server remux and the transcode claim would be empty.
      record(args, {
        gate: `EM6-transcode-source-codec:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: item.videoCodec === TRANSCODE_SOURCE_VIDEO_CODEC ? 'pass' : 'fail',
        note: `the server identified the source as ${item.videoCodec || '(none)'}; `
          + `the gate asks for ${TRANSCODE_TARGET_VIDEO_CODEC}`,
      });
      record(args, exactly(`EM6-transcode-segments:${opaqueRef('entry', key).slice(0, 12)}`,
        result.segments, maxSegments, `${result.bytes} bytes of transcoded output consumed`));
      record(args, {
        gate: `EM6-transcode-output-nonempty:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: result.bytes > 0 && result.firstSegment.byteLength > 0 ? 'pass' : 'fail',
        measured: result.bytes,
      });
      // LEAST EXPOSURE, MEASURED AT RUNTIME. The gate authors no URL containing a credential; this asserts the
      // server did not hand one back either, in the playlists it generated from a header-authenticated
      // request. Anything found would have been stripped before the URL was followed.
      record(args, exactly(`EM6-no-credential-in-generated-urls:${opaqueRef('entry', key).slice(0, 12)}`,
        result.credentialsInGeneratedUrls, 0,
        'server-generated playlist URLs carried no api key, so no credential propagated into a playlist body'));
      record(args, {
        gate: `EM6-transcode-session-reported:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: 'pass',
        note: `session reported transcoding=${result.sessionSawTranscode}`
          + `${result.transcodeReasons.length ? ` reasons=${result.transcodeReasons.join('|')}` : ''}. `
          + 'Corroboration, recorded rather than relied on: the evidence is the decode, which happens outside '
          + 'this process',
      });
      const out = need(args, 'out-segment');
      mkdirSync(out.replace(/[^/\\]*$/, '') || '.', { recursive: true });
      writeFileSync(out, result.firstSegment);
      console.log(`  wrote ${result.firstSegment.byteLength} bytes of transcoded output for decoding`);
      return;
    }

    case 'encoder-observability': {
      // FINDING 3, RECORDED AS A PHASE RATHER THAN CONFIGURED AWAY.
      //
      // The Jellyfin gate has a `configure-encoding` phase that sets `TranscodingTempPath` and
      // `ThrottleDelaySeconds`, and its comment says the temp path is what makes the encoder observable at
      // all. NEITHER FIELD EXISTS ON EMBY: `GET /System/Configuration/encoding` returns seventeen keys and no
      // transcoding path, and no throttle delay. So there is nothing to configure, and pretending otherwise —
      // by POSTing a document with fields the server ignores — would be a phase that reported success for
      // doing nothing.
      //
      // WHAT MAKES THE ENCODER OBSERVABLE HERE INSTEAD is that Emby writes to a FIXED path inside the volume
      // the gate already binds. This phase asserts that the directory the encoder-ahead measurement will read
      // is actually the one bound in, so a soak that later reports zero output files fails as "the encoder
      // wrote nothing" rather than silently as "the gate was looking in the wrong place".
      const producerDir = need(args, 'producer-dir');
      record(args, {
        gate: 'EM17-encoder-observable',
        verdict: existsSync(producerDir) ? 'pass' : 'fail',
        // WHAT THIS ESTABLISHES, AND WHAT IT DELIBERATELY DOES NOT. It establishes that the directory the
        // encoder-ahead measurement will read is really the one bound in. It does NOT license reading a
        // zero-file result as "the encoder wrote nothing": measured on this server, the soak's encoder-ahead
        // span came back at 0 seconds over 0 files, and that is equally consistent with the server writing
        // segments and deleting them once served — which the Jellyfin gate measured its own server doing, and
        // which a 15-second sampler can miss entirely. The number is RECORDED and asserted on by nothing
        // precisely because this gate cannot tell those two apart.
        note: `Emby's encoding configuration exposes no transcoding temp path and no throttle delay, so this `
          + `gate BINDS ${EMBY_TRANSCODING_TEMP_PATH} rather than setting one, and this asserts the host side `
          + 'of that bind exists. It does NOT establish what the encoder wrote: a zero-file encoder-ahead '
          + 'result is equally consistent with output that was written and deleted between samples, which is '
          + 'why that number is recorded and asserted on by nothing',
      });
      return;
    }

    case 'corpus-check': {
      // THE CORPUS CHECKED AGAINST ITSELF, BEFORE A MEDIA SERVER IS INVOLVED. Two entries with the same bytes
      // make every digest comparison in this gate decorative, and a ~50-entry corpus is generated by a loop —
      // exactly the thing that could quietly start emitting identical parameters.
      const expected = readExpected(need(args, 'expect-file')) as readonly CorpusExpectation[];
      const problems = corpusSelfProblems(expected);
      record(args, exactly('EM3-corpus-self-distinct', problems.length, 0,
        problems.length === 0
          ? `${expected.length} entries, every one a distinct name, size-bearing and distinctly digested`
          : problems.join('; ')));
      record(args, atLeast('EM3-corpus-size', expected.length, optionalNumber(args, 'min-entries', 50),
        'the acceptance plan\'s ~50-entry corpus'));
      const remote = expected.filter((entry) => entry.kind === 'http-range').length;
      record(args, atLeast('EM3-corpus-remote-entries', remote, optionalNumber(args, 'min-remote', 1),
        'entries whose bytes only exist behind the HTTP Range provider'));
      return;
    }

    case 'paced-play': {
      // G8: "Direct play starts within 10 s and runs 5 minutes without a stall."
      //
      // WHAT MAKES THIS DIFFERENT FROM `play`. That one proves the BYTES are right: it drains the whole
      // response and digests it, which takes a second or two. It cannot prove anything about five minutes, and
      // adding a sleep would produce a phase that took five minutes and measured a download. This one runs a
      // real decoder at the media's own rate and holds its progress trace against four separate numbers,
      // three of which exist specifically to fail the ways the first can be faked.
      //
      // IT CARRIES A CREDENTIAL, WHICH THE JELLYFIN EQUIVALENT DOES NOT, because Emby refuses anonymous
      // playback. The credential reaches the consumer through a file, never through an argument vector, and
      // the exposure is asserted below from Docker's own record of the container.
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const item = itemFor(items, key);
      const ref = opaqueRef('entry', key).slice(0, 12);
      // THE PLAN'S NUMBER IS WHAT IS ASSERTED; THE CONSUMER IS ASKED FOR MORE. `ffmpeg -t N` stops at the
      // last output frame at or before N, so the final progress record reports marginally under N and
      // `Math.floor` of it is N-1. A run of this gate failed at 299 against 300 with startup 2.3 s, no stall
      // and a healthy pacing ratio — a correct five minutes, failed by a rounding boundary. See
      // `PACED_PLAY_DECODE_MARGIN_SECONDS`: the assertion does not move, only the request, and it moves up.
      const seconds = optionalNumber(args, 'seconds', MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS);
      const consumerSeconds = seconds + PACED_PLAY_DECODE_MARGIN_SECONDS;
      const token = state.token;
      if (token === undefined || token === '') {
        fail('the paced consumer needs a credential on this server and the gate state holds none');
      }

      const outcome = await pacedDirectPlay({
        image: need(args, 'image'),
        network: need(args, 'network'),
        containerName: need(args, 'container-name'),
        // TWO SPELLINGS OF ONE DIRECTORY. `--work-dir` is what Docker bind-mounts and is absolute in the
        // shell's own dialect; `--local-work-dir` is what THIS process opens. On an MSYS shell they are not
        // interchangeable, and using one for both is what made the first complete run of this gate die at
        // `ENOENT ... \c\Users\...` twenty minutes in.
        workDir: need(args, 'work-dir'),
        localWorkDir: need(args, 'local-work-dir'),
        // The stream URL is built here and goes nowhere else: not into a result, not into a note, not into a
        // failure message. `withoutLocators` scrubs the consumer's own stderr for the same reason.
        streamUrl: `${need(args, 'stream-base')}/Videos/${item.itemId}/stream`
          + `?static=true&mediaSourceId=${encodeURIComponent(item.mediaSourceId)}`,
        outputRelPath: need(args, 'output-rel'),
        seconds: consumerSeconds,
        ffmpegPath: need(args, 'ffmpeg'),
        token,
        scriptRelPath: args.flags.get('script-rel') ?? 'out/paced-consumer.sh',
      });
      if (outcome.exitCode !== 0) {
        throw new GateFailure(`the paced consumer exited ${outcome.exitCode}: ${outcome.stderr.slice(-600)}`);
      }
      const analysis = analysePacedPlayback(outcome.samples);
      writeFileSync(need(args, 'trace'), `${JSON.stringify(outcome.samples, null, 2)}\n`);

      // THE CREDENTIAL-EXPOSURE ASSERTION, AND IT IS SPECIFIC TO THIS SERVER'S REFUSAL TO SERVE ANONYMOUSLY.
      //
      // `docker inspect` outlives the container and is readable by anything that can reach the Docker socket,
      // so a token on the `docker run` command line is a durable leak. This searches Docker's own record of
      // the consumer for the EXACT live token — a value, not a pattern, so it cannot false-positive on
      // something token-shaped and cannot be quietly loosened.
      //
      // AN EMPTY INSPECT IS A FAILURE, NOT A PASS. A search that found nothing because it read nothing is not
      // evidence, and this is exactly the shape of check that passes forever once the thing it reads goes away.
      record(args, {
        gate: `EM18-paced-play-inspect-observed:${ref}`,
        verdict: outcome.inspectJson.trim().length > 0 ? 'pass' : 'fail',
        note: 'Docker\'s record of the consumer container was actually read; an empty read would make the '
          + 'exposure check below a search of nothing',
      });
      const exposure = embyConsumerExposureProblems(outcome.inspectJson, token);
      record(args, exactly(`EM18-paced-play-credential-not-in-docker-metadata:${ref}`, exposure.length, 0,
        exposure.length === 0
          ? 'the live access token appears nowhere in the consumer container\'s Docker metadata: it was read '
            + 'from a file inside the run directory, not passed as an argument'
          : exposure.join('; ')));

      record(args, atLeast(`EM18-paced-play-samples:${ref}`, analysis.samples, 30,
        'progress records from the decoder itself, roughly one a second'));
      record(args, withinBudget(`EM18-paced-play-startup-seconds:${ref}`,
        Math.round(analysis.startupSeconds * 10) / 10, MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS,
        'from launching the consumer to its first decoded frame'));
      record(args, atLeast(`EM18-paced-play-wall-seconds:${ref}`, Math.floor(analysis.wallSeconds), seconds));
      // THE ONE A SLEEP CANNOT PASS. Wall clock is what a sleep buys; this is decoded media time, reported by
      // the decoder, and five minutes of it cannot be produced by waiting.
      record(args, atLeast(`EM18-paced-play-decoded-media-seconds:${ref}`,
        Math.floor(analysis.mediaSeconds), seconds,
        'media the consumer actually decoded, not wall clock it spent'));
      // ...AND THE ONE A FAST DRAIN CANNOT PASS.
      record(args, withinBudget(`EM18-paced-play-pacing-ratio-x100:${ref}`,
        Math.round(analysis.pacingRatio * 100), Math.round(MEDIA_SERVER_SOAK.MAX_PACING_RATIO * 100),
        'decoded media seconds per wall second: a player is ~100, a download is thousands'));
      record(args, atLeast(`EM18-paced-play-pacing-floor-x100:${ref}`,
        Math.round(analysis.pacingRatio * 100), Math.round(MEDIA_SERVER_SOAK.MIN_PACING_RATIO * 100),
        'and a consumer that slept through the window sits near zero'));
      record(args, withinBudget(`EM18-paced-play-longest-stall-seconds:${ref}`,
        Math.round(analysis.longestStallSeconds), MEDIA_SERVER_SOAK.MAX_STALL_SECONDS,
        'the longest wall interval in which the decoder made no progress at all'));
      return;
    }

    case 'paced-play-output': {
      // The consumer's own output, decoded by a decoder outside this process. "Playable output" is a
      // decoder's answer; a byte count is not one.
      const seconds = optionalNumber(args, 'seconds', MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS);
      record(args, atLeast('EM18-paced-play-output-seconds', optionalNumber(args, 'probed-seconds', 0),
        Math.floor(seconds * 0.98), 'the decoded output re-probed end to end'));
      record(args, atLeast('EM18-paced-play-output-packets', optionalNumber(args, 'probed-packets', 0), 1,
        'the output has decodable video packets in it'));
      return;
    }

    case 'media-seeks': {
      // G9: "Ten seeks, including backwards and to > 90 % of duration, each producing playable video
      // within 10 s."
      const state = readState(need(args, 'state'));
      const items = readItems(need(args, 'items'));
      const key = need(args, 'key');
      const item = itemFor(items, key);
      const ref = opaqueRef('entry', key).slice(0, 12);
      const duration = optionalNumber(args, 'duration-seconds', 0);
      if (duration <= 0) fail('--duration-seconds is required and must be positive');

      // THE PLAN IS CHECKED BEFORE IT IS RUN. Every per-seek assertion would pass just as happily against ten
      // seeks into the first minute; the properties that make the SET worth running belong to the list.
      const planProblems = seekPlanProblems(SEEK_PLAN_FRACTIONS);
      record(args, exactly(`EM19-seek-plan:${ref}`, planProblems.length, 0,
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
      }, null, 2)}\n`);

      // THE PLAYLIST THE SEEKS WERE PERFORMED THROUGH, CHECKED AS A DOCUMENT.
      //
      // WHY THIS IS NOT REDUNDANT WITH THE PER-SEEK ASSERTIONS. On this server the position the gate compares
      // against — `serverPositionSeconds` — comes from the cumulative `#EXTINF` sums of this playlist, because
      // Emby's segment URLs carry no `runtimeTicks` (finding 4). A playlist of one segment, or one whose
      // durations are all zero, makes that number identically zero for all ten seeks and turns
      // `maxPositionErrorSeconds` into a measurement of nothing — while every per-seek check still passes.
      record(args, exactly(`EM19-seek-playlist-usable:${ref}`, outcome.playlistProblems.length, 0,
        outcome.playlistProblems.length === 0
          ? 'the server\'s own playlist states a position for every segment and describes this item\'s media'
          : outcome.playlistProblems.join('; ')));
      // AND THE SOURCE OF THOSE POSITIONS IS STILL THE ONE THAT WAS MEASURED. If a future Emby started
      // publishing `runtimeTicks` on its segment URLs, this driver would go on summing `#EXTINF` while a
      // better number sat unused — so a non-zero count here says "re-measure which source is authoritative"
      // rather than continuing silently.
      record(args, exactly(`EM19-seek-segment-position-source:${ref}`, outcome.segmentsDeclaringPosition, 0,
        'no segment URL declares its own position, so the server states them only through #EXTINF; if this '
        + 'ever becomes non-zero the position source must be re-measured rather than inherited'));

      // THE PER-SEEK CEILING, which is the half of G9 about a viewer waiting for a picture.
      for (const seek of outcome.seeks) {
        record(args, withinBudget(`EM19-seek-${seek.index}-seconds:${ref}`,
          Math.round(seek.elapsedMs / 100) / 10, MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS,
          `to ${Math.round((seek.requestedSeconds / duration) * 100)}% of duration`));
      }
      record(args, exactly(`EM19-seek-count:${ref}`, outcome.seeks.length, MEDIA_SERVER_SOAK.SEEK_COUNT));
      record(args, exactly(`EM19-seek-no-credential-in-generated-urls:${ref}`,
        outcome.credentialsInGeneratedUrls, 0));
      record(args, withinBudget(`EM19-seek-playlist-duration-drift-seconds:${ref}`,
        Math.round(Math.abs(outcome.playlistSeconds - duration)), 6,
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

      record(args, exactly(`EM19-seek-decoded-count:${ref}`, analysis.count - analysis.unprobed,
        MEDIA_SERVER_SOAK.SEEK_COUNT, 'every seek position was decoded, not a sample of them'));
      record(args, exactly(`EM19-seek-wrong-codec:${ref}`, analysis.wrongCodec, 0,
        `every seek produced ${TRANSCODE_TARGET_VIDEO_CODEC} from an ${TRANSCODE_SOURCE_VIDEO_CODEC} source`));
      record(args, exactly(`EM19-seek-empty-of-video:${ref}`, analysis.emptyOfVideo, 0,
        'a segment with no decodable video packets is not playable video'));
      record(args, withinBudget(`EM19-seek-slowest-seconds:${ref}`,
        Math.round(analysis.slowestSeconds * 10) / 10, MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS));
      // TEN SEEKS, NOT ONE SEEK TEN TIMES.
      record(args, exactly(`EM19-seek-distinct-segments:${ref}`, analysis.distinctSegments,
        MEDIA_SERVER_SOAK.SEEK_COUNT, 'ten different segments came back, byte for byte'));
      record(args, atLeast(`EM19-seek-backward-transitions:${ref}`, analysis.backwardTransitions,
        MEDIA_SERVER_SOAK.MIN_BACKWARD_SEEKS, 'the plan really did go backwards, in the order it was run'));
      record(args, atLeast(`EM19-seek-past-90-percent:${ref}`, analysis.deepSeeks, 1));
      record(args, withinBudget(`EM19-seek-position-error-seconds:${ref}`,
        Math.round(analysis.maxPositionErrorSeconds * 10) / 10,
        MEDIA_SERVER_SOAK.MAX_SEEK_POSITION_ERROR_SECONDS,
        'the worst gap between the position asked for and the one the server said it was serving'));
      // THE TEMPORAL ASSERTION. The decoded timestamps move one second per second of media asked for; the
      // constant offset between them is one server's presentation-time base and is measured, not assumed —
      // 10.0 s on the pinned Emby, across every seek sampled while this gate was built.
      record(args, withinBudget(`EM19-seek-decoded-offset-spread-x10:${ref}`,
        Math.round(analysis.decodedOffsetSpreadSeconds * 10),
        Math.round(MEDIA_SERVER_SOAK.MAX_SEEK_DECODED_OFFSET_SPREAD_SECONDS * 10),
        'how much the decoded-timestamp offset varied across the ten seeks; a server that ignored the '
        + 'position would vary by the whole duration'));
      record(args, atLeast(`EM19-seek-decoded-span-seconds:${ref}`,
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
      // WHAT THIS GATE CLAIMS, IN ONE SENTENCE, SO THE ASSERTIONS CAN BE READ AGAINST IT: five minutes of
      // PACED, CONTINUOUSLY DECODED, TRANSCODED PLAYBACK. Not five minutes of an encoder process being busy —
      // see the encoder span below, which is recorded and is not that.
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

      record(args, atLeast(`EM20-transcode-soak-wall-seconds:${ref}`,
        Math.floor(analysis.wallSpanSeconds), seconds,
        'wall clock between the first segment arriving and the last, at a player\'s pace'));
      // THE ONE THAT TURNS AN ELAPSED WINDOW INTO A CONTINUOUS ONE.
      record(args, withinBudget(`EM20-transcode-soak-longest-arrival-gap-seconds:${ref}`,
        Math.round(analysis.maxArrivalGapSeconds), MEDIA_SERVER_SOAK.MAX_SEGMENT_ARRIVAL_GAP_SECONDS,
        'the longest wall gap between two consecutive transcoded segments arriving, including the first'));
      record(args, atLeast(`EM20-transcode-soak-decoded-seconds:${ref}`,
        Math.floor(analysis.decodedMediaSeconds), seconds,
        'media time actually decoded out of the transcoded output, not segments counted'));
      // ...AND THE ONE THAT REFUSES A FRONT-LOADED RUN.
      record(args, atLeast(`EM20-transcode-soak-late-window-decoded-seconds:${ref}`,
        Math.floor(analysis.lateWindowDecodedSeconds),
        Math.floor(seconds * MEDIA_SERVER_SOAK.MIN_LATE_WINDOW_DECODED_FRACTION),
        'decoded h264 media time among the segments that arrived in the LAST THIRD of the window'));
      record(args, exactly(`EM20-transcode-soak-unprobed-segments:${ref}`, analysis.unprobed, 0,
        'every consumed segment was decoded, so the decoded total is not a sample'));
      record(args, exactly(`EM20-transcode-soak-distinct-segments:${ref}`,
        analysis.distinctSegments, analysis.segments,
        'every segment is a different segment: one window delivered fifty times is not fifty segments'));
      // THE ASSERTION THAT CARRIES G10, ANCHORED AT BOTH ENDS INSIDE THIS PHASE. "Every segment decoded as
      // h264" says nothing at all if the source was h264 to begin with, and a phase whose two halves live in
      // different steps is a phase where one half can quietly stop being true.
      const sourceCodec = itemFor(readItems(need(args, 'items')), key).videoCodec;
      record(args, {
        gate: `EM20-transcode-soak-source-codec:${ref}`,
        verdict: sourceCodec === TRANSCODE_SOURCE_VIDEO_CODEC ? 'pass' : 'fail',
        note: `the media server identified the source as ${sourceCodec || '(none)'}; a transcode to `
          + `${TRANSCODE_TARGET_VIDEO_CODEC} from a source that was already ${TRANSCODE_TARGET_VIDEO_CODEC} `
          + 'would prove nothing about an encoder',
      });
      record(args, exactly(`EM20-transcode-soak-wrong-codec:${ref}`, analysis.wrongCodec, 0,
        `the source is ${TRANSCODE_SOURCE_VIDEO_CODEC} throughout and every segment decoded as `
        + `${TRANSCODE_TARGET_VIDEO_CODEC}`));
      record(args, exactly(`EM20-transcode-soak-empty-segments:${ref}`, analysis.emptyOfVideo, 0));

      // TWO MEASUREMENTS RECORDED AND DELIBERATELY NOT ASSERTED ON, each with the reason.
      //
      // THE ENCODER'S OWN OUTPUT SPAN. Emby's encoding configuration exposes no throttle delay (finding 3) and
      // ships with `EnableThrottling: false`, and the gate does not turn it on — tuning the server to make a
      // number nobody asserts on look better is how a recorded measurement becomes a managed one. So this is
      // how far AHEAD OF THE PACED CLIENT the encoder ran, reported under that description and nothing else.
      record(args, {
        gate: `EM20-transcode-soak-encoder-ahead-span-seconds:${ref}`,
        verdict: 'pass',
        measured: Math.round(analysis.encoderAheadSpanSeconds), budget: seconds,
        note: `${analysis.encoderOutputFiles} file(s) written by the transcoding job inside this window. `
          + 'RECORDED, NOT ASSERTED: the encoder races ahead of a paced client and exits, so this is how far '
          + 'ahead it ran and is NOT evidence that it was busy for five minutes. The five-minute claim rests '
          + 'on the continuity of decoded output above',
      });
      record(args, {
        gate: `EM20-transcode-soak-encoder-live-samples:${ref}`,
        verdict: 'pass',
        measured: analysis.encoderLiveSamples, budget: analysis.sessionSamples,
        note: 'samples in which the server was still reporting a LIVE transcoding job. RECORDED, NOT '
          + 'ASSERTED: it goes null once the encoder exits. G10 is NOT closed as five minutes of encoder '
          + 'liveness by this gate',
      });
      // SAMPLES ARE SUCCESSFUL READS ONLY, and the failures beside them are gated at zero — otherwise a run
      // whose polls all failed satisfies "sampled across the window" with nothing but its own failures.
      record(args, exactly(`EM20-transcode-soak-failed-session-polls:${ref}`, raw.failedSessionPolls, 0,
        'session reads that never reached the server; a failed read is not an observation that the server '
        + 'reported nothing, and it may not be counted as one'));
      record(args, atLeast(`EM20-transcode-soak-session-samples:${ref}`, analysis.sessionSamples, 10,
        'successful session reads across the window, not one at the start'));
      record(args, atLeast(`EM20-transcode-soak-session-present-samples:${ref}`, analysis.sessionPresentSamples,
        Math.ceil(analysis.sessionSamples * MEDIA_SERVER_SOAK.MIN_SESSION_PRESENT_SAMPLE_FRACTION),
        `samples in which a session for THIS gate's device and this item existed at all, of `
        + `${analysis.sessionSamples} successful reads`));
      record(args, {
        gate: `EM20-transcode-soak-reported-method-samples:${ref}`,
        verdict: 'pass',
        measured: analysis.transcodeMethodSamples, budget: analysis.sessionSamples,
        note: 'samples in which the server reported this session\'s playback method as Transcode. RECORDED, '
          + 'NOT ASSERTED: the Jellyfin gate\'s three-arm negative control showed this field is '
          + 'client-writable in this API family, so it is not the server\'s independent account. This gate '
          + 'authors no PlayMethod, and the transcode claim rests on the decoded mpeg4-to-h264 output above',
      });
      record(args, exactly(`EM20-transcode-soak-failed-playback-reports:${ref}`,
        raw.failedPlaybackReports, 0,
        'playback reports the server refused; a non-zero count makes the session telemetry beside it '
        + 'meaningless rather than merely low'));
      record(args, exactly(`EM20-transcode-soak-no-credential-in-generated-urls:${ref}`,
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

      // ONE RESPONSE, OPENED ONCE. Not two ranged reads either side of the event.
      const stream = await openPinnedStream(state, item);
      await stream.readAtLeast(prefix);
      const bytesBefore = stream.bytesRead;

      record(args, {
        gate: `EM7-stream-open-at-event:${ref}`,
        verdict: !stream.ended && bytesBefore < want.sizeBytes ? 'pass' : 'fail',
        measured: bytesBefore, budget: want.sizeBytes,
        note: 'one response body, partially consumed and deliberately not drained',
      });

      mkdirSync(readyPath.replace(/[^/\\]*$/, '') || '.', { recursive: true });
      writeFileSync(readyPath, `${bytesBefore}\n`);
      console.log(`  the stream is live and unfinished: ${bytesBefore}/${want.sizeBytes} bytes consumed`);
      await awaitFile(releasePath, 'the gate to finish acting on the daemon',
        MEDIA_SERVER_DEADLINES_MS.HANDSHAKE);

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
          gate: `EM7-open-stream-across-event:${ref}`,
          verdict: correct ? 'pass' : 'fail',
          measured: result.bytes, budget: want.sizeBytes,
          note: 'one held-open response delivered the whole file correctly across the event',
        });
        // ANTI-BUFFERING. If the body had already been buffered in full before the pause, nothing would have
        // arrived afterwards and "held open" would be a fiction.
        const after = result.bytes - bytesBefore;
        record(args, {
          gate: `EM7-bytes-after-event:${ref}`,
          verdict: after >= Math.floor(want.sizeBytes / 4) ? 'pass' : 'fail',
          measured: after, budget: Math.floor(want.sizeBytes / 4),
          note: 'bytes delivered by the same response AFTER the event, so the pause was real',
        });
      } else if (allowInterrupt) {
        // THE DOCUMENTED ALLOWED BEHAVIOUR, and only where the acceptance plan says it is: G12 says playback
        // is expected to fail across a SIGKILL and be resumable, and that the LIBRARY is not.
        record(args, {
          gate: `EM7-open-stream-interrupted:${ref}`,
          verdict: 'pass',
          note: `the held-open stream failed, which the acceptance plan permits for this event. This is NOT `
            + `evidence of generation pinning; resumability is asserted separately by a new request. ${detail}`,
        });
      } else {
        record(args, { gate: `EM7-open-stream-across-event:${ref}`, verdict: 'fail', note: detail });
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
        gate: `EM8-resume-after-recovery:${opaqueRef('entry', key).slice(0, 12)}`,
        verdict: result.bytes === want.sizeBytes && result.sha256 === want.sha256 ? 'pass' : 'fail',
        measured: result.bytes, budget: want.sizeBytes,
        note: 'playback is resumable and the bytes are still the published ones',
      });
      return;
    }

    case 'compare': {
      // Two item listings, and what changed between them. This is the churn gate, and the acceptance plan is
      // strictest about it: a daemon crash must not make a library shrink.
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
      const duplicated = [...counts.values()].filter((count) => count > 1).length;
      record(args, exactly(`${gate}-duplicates`, duplicated, 0));

      // IDENTITY, not just presence. A media server that re-created an item under a new id has lost every
      // piece of watch state attached to it, and a count comparison would call that a clean re-scan.
      //
      // ON EMBY THE ID IS A DATABASE ROW ID rather than a path-derived GUID, so a stable id proves the row
      // survived and does NOT independently corroborate the path the way Jellyfin's does. The path and size
      // comparisons below carry that half on their own — see `EMBY_ITEM_IDS_ARE_DATABASE_ROW_IDS`.
      let churned = 0;
      for (const item of before) {
        if (!afterKeys.has(item.key)) continue;
        const nowItem = after.find((entry) => entry.key === item.key) as ItemRecord;
        if (nowItem.itemId !== item.itemId) churned += 1;
      }
      record(args, exactly(`${gate}-item-id-churn`, churned, 0,
        'carried items keep the id they were first given'));

      // And the metadata the server derived from the file has not moved either.
      let moved = 0;
      for (const item of before) {
        const nowItem = after.find((entry) => entry.key === item.key);
        if (nowItem && (nowItem.sizeBytes !== item.sizeBytes || nowItem.container !== item.container)) {
          moved += 1;
        }
      }
      record(args, exactly(`${gate}-metadata-drift`, moved, 0));

      // THE PROJECTED PATH ITSELF, which on this server is the half a stable id does not carry.
      let relocated = 0;
      for (const item of before) {
        const nowItem = after.find((entry) => entry.key === item.key);
        if (nowItem && nowItem.path !== item.path) relocated += 1;
      }
      record(args, exactly(`${gate}-path-drift`, relocated, 0,
        'a carried item is still at the path the control plane published for it'));
      return;
    }

    case 'counters': {
      const url = need(args, 'url');
      // A ref'd watchdog, for the same reason every other request in this gate has one.
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
      // the object's own length, and the fraction says it must not.
      //
      // THE TWO AGGREGATE DENOMINATORS THAT USED TO BE HERE ARE GONE, and their removal is the correction.
      // They were `MAX_SCAN_BYTE_FRACTION x (bytes above the single-probe threshold)` plus
      // `MAX_SMALL_OBJECT_SCAN_BYTE_MULTIPLIER x (bytes below it)` — one pooled number over a whole corpus, so
      // one object could still spend another's allowance, and on the only object where the fraction actually
      // bound it landed between the daemon's two legitimate read patterns. Per-object attribution replaces
      // the pooling and the block geometry replaces the unreachable fraction; the fraction itself is
      // unchanged and is asserted where it is testable.
      // THE SAME SHARED RULE THE JELLYFIN GATE USES, from the same module, for the same reason: an aggregate
      // fraction over a corpus of small objects is unreachable by construction, and the Unraid run that
      // exposed it failed on an 8,594,275-byte object whose two legitimate read patterns straddled the
      // ceiling. `MAX_SCAN_BYTE_FRACTION` is unchanged; where it is asserted is what moved.
      for (const result of scanByteResults(gate, {
        committed: delta('bytesServed'),
        observed: delta('observedBytes'),
        truncatedBodies: delta('truncatedBodies'),
        rangeRequests: delta('rangeRequests'),
        bodiesInFlight: after.bodiesInFlight ?? 0,
      }, objectAttribution(before), objectAttribution(after),
      { requireFractionBearingObject: args.flags.get('require-large-object') === 'true' })) {
        record(args, result);
      }
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
      // WHY THE SCAN BUDGETS DO NOT APPLY. `budget` measures a metadata pass, whose whole argument is that it
      // reads a fraction of the object. A five-minute PLAYBACK legitimately reads the object — that is what
      // playing it means — so a fraction budget over it would be a gate that could not pass, and leaving the
      // window unmeasured would be a gate that could not fail. What is bounded instead is AMPLIFICATION.
      const before = JSON.parse(readFileSync(need(args, 'before'), 'utf8')) as Record<string, number>;
      const after = JSON.parse(readFileSync(need(args, 'after'), 'utf8')) as Record<string, number>;
      const gate = need(args, 'gate');
      const objectBytes = optionalNumber(args, 'object-bytes', 1);
      const multiplier = optionalNumber(args, 'max-object-multiplier', 3);
      const delta = (key: string): number => (after[key] ?? 0) - (before[key] ?? 0);

      for (const result of providerByteResults(gate, {
        committed: delta('bytesServed'),
        observed: delta('observedBytes'),
        truncatedBodies: delta('truncatedBodies'),
        rangeRequests: delta('rangeRequests'),
        bodiesInFlight: after.bodiesInFlight ?? 0,
      }, Math.floor(objectBytes * multiplier),
      `denominator: the object's own ${objectBytes} bytes, read at most ${multiplier}x over the window`)) {
        record(args, result);
      }
      record(args, withinBudget(`${gate}-range-requests`, delta('rangeRequests'),
        optionalNumber(args, 'max-range-requests', 4096),
        'a ranged read per window the daemon needed, and a ceiling a runaway read-ahead would blow'));
      // A WARM WINDOW IS NOT A FAILURE, AND IT IS NOT A FREE PASS EITHER. See `readWarmCacheEvidence` for the
      // floor this replaces and the daemon repair that invalidated it. Zero provider requests AND no daemon
      // cache evidence is still a failure, and it is the same failure the old floor was aimed at.
      const providerRequests = delta('rangeRequests');
      if (providerRequests > 0) {
        // COLD, AND UNCHANGED. The window reached the provider, so the original floor is exactly right and is
        // asserted under its original name. Nothing about a cold run's verdicts moves.
        record(args, atLeast(`${gate}-range-requests-floor`, providerRequests,
          optionalNumber(args, 'min-range-requests', 1),
          'a window in which the provider was never reached means the bytes came from somewhere else'));
      } else if (providerRequests < 0) {
        // A PROVIDER COUNTER THAT FELL IS A BROKEN INSTRUMENT, NOT A WARM WINDOW. The endpoint restarted, or
        // its counters were reset, between the two readings — so the window describes no interval at all, and
        // neither a ceiling nor a warm-cache claim can be made about it. The warm arm is reached on EXACTLY
        // zero and nothing else.
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
      // ABSOLUTE, NOT A DELTA. These are zero (or under a cap) for the WHOLE run, not merely across some
      // window of it. A delta check would let a 429 during direct play cancel out against a window that did
      // not include it, and "the admission limits held during the scan" is much weaker than "they never
      // stopped holding".
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

    case 'cache-accounting': {
      // THE PROBE CACHE'S SIZE, HELD AGAINST WHAT A FIXED-WINDOW PLAN CAN ACCOUNT FOR.
      //
      // WHY A SIZE CHECK AND NOT ONLY A SUBSTRING SEARCH. The leak checks elsewhere in this gate search the
      // cache for provider access material, and they would notice a token. They would notice NOTHING about a
      // read path that quietly started writing whole objects through the cache — every byte of which is
      // legitimate media. The size is the only instrument that sees that, and the ceiling is generous on
      // purpose: what it rules out is an order of magnitude, not a byte.
      const bytes = optionalNumber(args, 'cache-bytes', -1);
      const ceiling = optionalNumber(args, 'ceiling-bytes', 0);
      const published = optionalNumber(args, 'published-bytes', 0);
      if (bytes < 0) fail('--cache-bytes is required and the cache size could not be measured');
      record(args, withinBudget('EM21-probe-cache-within-window-plan', bytes, ceiling,
        'three fixed windows per version, or the whole object below the single-probe threshold, plus slack'));
      record(args, withinBudget('EM21-probe-cache-smaller-than-library', bytes, Math.max(0, published - 1),
        'a scan-window cache the size of the library it caches windows of is not a window cache'));
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
      console.log(`Projection Phase 1 — EMBY data plane: ${results.length} assertions, `
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

    case 'consumer-token-file': {
      // The name of the file the paced consumer reads its credential from, for the shell's leak checks.
      // Printed rather than duplicated, so the gate script and the driver cannot disagree about it.
      console.log(EMBY_CONSUMER_TOKEN_FILE);
      return;
    }

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

// A PHASE THAT ENDS WITHOUT SAYING SO IS A FAILURE, NOT A PASS.
//
// The keepalive holds the event loop open for as long as a phase is running, so an idle await cannot let Node
// exit; and the flag makes an exit that happens anyway — for any reason at all — carry a non-zero status and a
// message, instead of an empty stdout and a 0 the caller reads as "that phase passed".
let finished = false;
const keepalive = setInterval(() => undefined, 1_000);
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('projection-emby-dataplane: the phase exited without completing');
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
