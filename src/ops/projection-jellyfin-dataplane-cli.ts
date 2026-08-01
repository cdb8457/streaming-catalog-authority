import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MEDIA_SERVER_BUDGETS, MEDIA_SERVER_DEADLINES_MS, TRANSCODE_SOURCE_VIDEO_CODEC,
  TRANSCODE_TARGET_VIDEO_CODEC, atLeast, exactly, findRedactionProblems, opaqueRef, withinBudget,
  type GateResult,
} from '../core/projection/media-server-dataplane.js';
import {
  GateFailure, addMovieLibrary, appendResult, awaitFile, awaitServer, bootstrap, directPlay,
  forcedTranscode, listMovies, openPinnedStream, rangeRead, readExpected, readResults, readState,
  resolveLibraryId, scanLibrary, writeState, type GateState, type ItemRecord,
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
//   budget       --before F --after F --gate G --entries N --bytes N --windows N
//   report       --results F [--json F]

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
        record(args, {
          gate: `JD3-${label}-scan-observed-running`,
          verdict: outcome.observedRunning ? 'pass' : 'fail',
          note: 'the scanner was observed in flight, which is what makes the mid-scan publish a mid-scan publish',
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

      for (const want of expected) {
        const item = itemFor(items, want.key);
        // THE MEDIA SERVER'S OWN VIEW OF THE FILE, checked against what was published — size from its probe,
        // not from a stat this gate did itself.
        record(args, exactly(`JD3-${label}-size:${opaqueRef('entry', want.key).slice(0, 12)}`,
          item.sizeBytes, want.sizeBytes));
        // ORDINARY FILES. Not a symlink, not a `.strm` placeholder pointing somewhere else, not a remote
        // media source the server would fetch over HTTP itself. This is the claim the whole appliance rests
        // on: a media server treats the projection as a disk.
        const ordinary = item.protocol === 'File' && !item.isRemote && !item.key.endsWith('.strm')
          && item.container !== '' && item.locationType === 'FileSystem' && item.supportsDirectPlay;
        record(args, {
          gate: `JD3-${label}-ordinary-file:${opaqueRef('entry', want.key).slice(0, 12)}`,
          verdict: ordinary ? 'pass' : 'fail',
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
      record(args, withinBudget(`${gate}-provider-bytes`, delta('bytesServed'),
        Math.floor(remoteBytes * MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION),
        `denominator: ${remoteBytes} remote bytes published`));
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
