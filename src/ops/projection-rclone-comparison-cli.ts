import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  corpusProblems, corpusSelfProblems, exactly, findRedactionProblems, opaqueRef, atLeast,
  type CorpusExpectation, type GateResult,
} from '../core/projection/media-server-dataplane.js';
import {
  CONCURRENCY_DEADLINES_MS, CONCURRENCY_RULES, REQUIRED_SERVER_COUNT, THREE_SERVER_IDS,
  analyseOverlap, overlapProblems, triggerSpreadSeconds,
  type OverlapSample, type ThreeServerId,
} from '../core/projection/three-server-concurrency.js';
import {
  COMPARISON_CORPUS_ENTRIES, COMPARISON_HOLD_ARM_MS, PRODUCT_REMOTE_ENTRIES,
  RCLONE_COMPARISON_NONCLAIMS, RCLONE_COMPARISON_TOPOLOGY, RCLONE_TIMEOUTS_MS,
  clientStatsProblems, comparisonColdStateProblems, comparisonMeasurements, parseClientStats,
  parseWebdavCounters, webdavAttributionProblems,
  type ClientStats, type WebdavCounters,
} from '../core/projection/rclone-comparison.js';
import {
  adapterFor, allAdapters, forgetClientCache, clientVersion, readClientStats, readWebdavCounters,
  readSettledWebdavCounters, readRegisteredObjects, revealCorpus, runConcurrentScans, setHold,
  type CatalogueEntry, type ConcurrentScanOutcome,
} from './projection-rclone-comparison.js';

// The Projection Phase 1 RCLONE/WEBDAV COMPARISON CONTROL (G22), from the command line.
//
// WHAT G22 IS: "The same corpus behind an rclone/WebDAV mount, measured the same way. This is EVIDENCE, NOT
// ARCHITECTURE: it exists to record what the naive approach costs. It has NO PASS THRESHOLD."
// (`docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5.)
//
// SO THIS CLI HAS TWO KINDS OF ASSERTION AND THEY MUST NOT BE CONFUSED WITH EACH OTHER:
//
//   THINGS THAT FAIL CLOSED — the mount works, the corpus is exactly the corpus, the three servers really
//     scanned and really overlapped, the telemetry is coherent and monotonic and fully attributed, the window
//     was cold, no credential leaked, no assertion was skipped. Every one of them is a property of the
//     INSTRUMENT or of the SHAPE of the comparison, and a run that cannot establish one has not measured
//     anything.
//
//   THINGS THAT ARE MERELY RECORDED — every cost figure, without exception. They are emitted with a `note`
//     and deliberately WITHOUT a `measured`/`budget` pair, because `GateResult` says those two travel
//     together and a figure with a budget is a threshold. An expensive number here is the finding; a gate
//     that failed on it would be a gate nobody could run to produce the finding.
//
//   counters       --url U --out F              client-stats --rc U --out F
//   reveal         --endpoint U                 forget       --rc U
//   client-alive   --rc U
//   concurrent-scan --state-emby F --state-jellyfin F --state-plex F --endpoint U --barrier-ref R
//                   --out F --catalogue-dir D [--sample-interval-ms N] [--hold-arm-ms N]
//   verify-overlap --scan F
//   verify-corpus  --server ID --catalogue F --expect-file F
//   telemetry      --before F --after F --objects N --gate G
//   cold-window    --before F --after F --gate G --first-corpus-ordinal N --corpus-objects N
//                  --client-cache-before N
//   measure        --before F --after F --gate G --first-corpus-ordinal N --product-ordinals CSV
//                  --client-stats-before F --client-stats-after F --client-cache-before N
//                  --client-cache-after N --scan F
//   nonclaims      report --results F [--json F]      redaction-check --file F

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
  console.error(`projection-rclone-comparison: ${message}`);
  process.exit(1);
}

function need(args: Args, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined) fail(`--${name} is required`);
  return value;
}

function needNumber(args: Args, name: string): number {
  const value = Number(need(args, name));
  if (!Number.isFinite(value)) fail(`--${name} is not a number`);
  return value;
}

function optionalNumber(args: Args, name: string, fallback: number): number {
  const raw = args.flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`--${name} is not a number`);
  return value;
}

class GateFailure extends Error {}

function record(args: Args, result: GateResult): void {
  const path = args.flags.get('results');
  if (path !== undefined) {
    const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as GateResult[] : [];
    existing.push(result);
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
  }
  const measured = result.measured === undefined ? '' : ` measured=${result.measured} budget=${result.budget}`;
  console.log(`  ${result.verdict.toUpperCase()}  ${result.gate}${measured}`
    + `${result.note ? ` — ${result.note}` : ''}`);
  if (result.verdict === 'fail') throw new GateFailure(`${result.gate} failed`);
}

/**
 * A RECORDED FIGURE. No `measured`, no `budget`, and that omission is the mechanism rather than an oversight.
 *
 * `GateResult` documents `measured` and `budget` as "both, or neither", so a figure emitted through this
 * helper CANNOT acquire a threshold without somebody deliberately switching to `withinBudget` — which the
 * offline suite then catches, because it asserts that no G22 comparative figure carries a budget. That is
 * what keeps "G22 has no pass threshold" a property of the code rather than a promise in a comment.
 */
function figure(gate: string, note: string): GateResult {
  return { gate, verdict: 'pass', note };
}

/** Read a counters document, refusing anything a figure could not honestly be derived from. */
function readCounterFile(path: string, label: string): WebdavCounters {
  const parsed = parseWebdavCounters(JSON.parse(readFileSync(path, 'utf8')), label);
  if (parsed.counters === undefined) {
    for (const problem of parsed.problems.slice(0, 10)) console.error(`  ${problem.kind}: ${problem.detail}`);
    fail(`the ${label} counters document cannot support a comparison figure`);
  }
  return parsed.counters;
}

/** Read a persisted mount-client stats snapshot through the SAME parser the live read uses. */
function readClientStatsFile(path: string, label: string): ClientStats {
  const parsed = parseClientStats(JSON.parse(readFileSync(path, 'utf8')), label);
  if (parsed.stats === undefined) {
    for (const problem of parsed.problems.slice(0, 10)) console.error(`  ${problem.kind}: ${problem.detail}`);
    fail(`the ${label} mount-client stats cannot support a comparison figure`);
  }
  return parsed.stats;
}

function readScanOutcome(path: string): ConcurrentScanOutcome {
  return JSON.parse(readFileSync(path, 'utf8')) as ConcurrentScanOutcome;
}

/** A list of registration ordinals, as the shell can pass one. Empty is refused: an empty subset measures nothing. */
function ordinalList(args: Args, name: string): number[] {
  const raw = need(args, name).split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (raw.length === 0) fail(`--${name} named no ordinals`);
  const out = raw.map((entry) => {
    const value = Number(entry);
    if (!Number.isInteger(value) || value < 0) fail(`--${name} contains "${entry}", which is not an ordinal`);
    return value;
  });
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    // -----------------------------------------------------------------------------------------------------
    case 'counters': {
      // IT WAITS FOR EVERY BODY TO FINISH WRITING BEFORE IT READS, and that is not an optimisation.
      //
      // A snapshot taken mid-write has each in-flight body's COMMITTED length counted and its OBSERVED length
      // not, so the gap between the two totals would be a measurement of when the gate happened to look
      // rather than of what the client did. Both ends of the window wait: the `after` one obviously, and the
      // `before` one so that a body left writing by library creation cannot skew the baseline either.
      const url = need(args, 'url');
      const settled = args.flags.get('settled') !== 'false';
      const snapshot = settled
        ? await readSettledWebdavCounters(url, optionalNumber(args, 'settle-ms', 60_000))
        : await readWebdavCounters(url);
      writeFileSync(need(args, 'out'), `${JSON.stringify(snapshot, null, 2)}\n`);
      const inFlight = Number(snapshot.bodiesInFlight);
      console.log(`  endpoint counters recorded (${inFlight} body/bodies still writing)`);
      if (settled && inFlight !== 0) {
        fail(`the endpoint still had ${inFlight} body/bodies writing after the settle budget, so no `
          + 'observed-byte figure can be read from this snapshot');
      }
      return;
    }

    case 'client-stats': {
      // STRICTLY PARSED AT THE POINT OF READING. `readClientStats` refuses anything that is not an object
      // with its own whole, finite, non-negative `bytes` and `transfers`, so a client that stopped reporting
      // one fails here rather than contributing a confident zero to a published comparison.
      const stats = await readClientStats(need(args, 'rc'));
      writeFileSync(need(args, 'out'), `${JSON.stringify(stats, null, 2)}\n`);
      console.log(`  mount client stats recorded: ${stats.bytes} bytes over ${stats.transfers} transfers`);
      return;
    }

    case 'client-alive': {
      // THE MOUNT CLIENT IS ASKED WHO IT IS, ONCE, BEFORE ANYTHING DEPENDS ON IT. A mount that is not there
      // falls through to the empty directory underneath it, and every later "the server found nothing"
      // failure would then name the wrong thing.
      const version = await clientVersion(need(args, 'rc'));
      if (version === '') fail('the mount client did not name its own version');
      console.log(`  the mount client is alive and reports version ${version}`);
      return;
    }

    case 'reveal': {
      await revealCorpus(need(args, 'endpoint'));
      console.log('  the corpus is now visible at the endpoint');
      return;
    }

    case 'forget': {
      await forgetClientCache(need(args, 'rc'));
      console.log('  the mount client\'s cached listings were dropped');
      return;
    }

    case 'hold': {
      await setHold(need(args, 'endpoint'), need(args, 'ref'), need(args, 'held') === 'true');
      console.log(`  the barrier object is now ${need(args, 'held') === 'true' ? 'held' : 'released'}`);
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'concurrent-scan': {
      // THE SAME FUNCTION G18 USES, DRIVING THE SAME THREE DRIVERS, AGAINST A DIFFERENT MOUNT.
      //
      // That is the whole reason this command is four lines of composition. "Measured the same way" is only
      // true if it is the same measurement; a second observer written for this topology would make the
      // comparison include the difference between two observers.
      const adapters = allAdapters();
      const states = new Map<string, unknown>();
      for (const id of THREE_SERVER_IDS) {
        const path = need(args, `state-${id}`);
        if (!existsSync(path)) fail(`the ${id} state file is missing; its own bootstrap did not run`);
        states.set(id, adapterFor(id).readState(path));
      }
      const outcome = await runConcurrentScans({
        adapters,
        states,
        endpointBaseUrl: need(args, 'endpoint'),
        barrierRef: need(args, 'barrier-ref'),
        sampleIntervalMs: optionalNumber(args, 'sample-interval-ms', CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL),
        holdArmMs: optionalNumber(args, 'hold-arm-ms', COMPARISON_HOLD_ARM_MS),
        onNote: (message) => console.log(`  ${message}`),
      });

      const catalogueDir = need(args, 'catalogue-dir');
      mkdirSync(catalogueDir, { recursive: true });
      for (const adapter of adapters) {
        const entries = await adapter.catalogue(states.get(adapter.id));
        writeFileSync(`${catalogueDir}/catalogue-${adapter.id}.json`, `${JSON.stringify(entries, null, 2)}\n`);
      }
      writeFileSync(need(args, 'out'), `${JSON.stringify(outcome, null, 2)}\n`);

      const failures = outcome.perServer.filter((server) => server.failure !== undefined);
      for (const server of failures) console.error(`  the ${server.id} scan failed: ${server.failure}`);
      if (failures.length > 0) fail(`${failures.length} of ${adapters.length} concurrent scans failed`);
      console.log(`  ${adapters.length} concurrent scans completed; `
        + `${outcome.timeline.length} observation samples recorded`);
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'verify-overlap': {
      // THE SHAPE OF THE COMPARISON, WHICH FAILS CLOSED EVEN THOUGH THE COST FIGURES DO NOT.
      //
      // "Three sequential scans" and "three concurrent scans" cost a shared mount client very different
      // amounts, so a run that labelled the first as the second would be comparing G18's concurrent window
      // against a sequential one and calling the difference a property of the topology. The floors here are
      // G18's own, applied by G18's own analysis, for exactly that reason.
      const outcome = readScanOutcome(need(args, 'scan'));
      const analysis = analyseOverlap(outcome.timeline as OverlapSample[], THREE_SERVER_IDS);
      const problems = overlapProblems(analysis);

      record(args, exactly('RC1-servers-observed-scanning', analysis.serversObservedInFlight,
        REQUIRED_SERVER_COUNT,
        'each server\'s OWN present-tense answer, not "we asked it to scan and have not seen it stop"'));
      record(args, atLeast('RC1-max-servers-in-flight-at-once', analysis.maxServersInFlight,
        REQUIRED_SERVER_COUNT,
        'one would be what three SEQUENTIAL scans look like, and a sequential window is not the window G18 '
        + 'measured'));
      record(args, atLeast('RC1-continuous-simultaneous-samples',
        analysis.longestContinuousSimultaneousSamples, CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES,
        'the longest UNBROKEN run of samples with every server scanning, broken by any idle, unreadable or '
        + `imprecise sample and by any gap over ${CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP}ms`));
      record(args, atLeast('RC1-continuous-simultaneous-seconds',
        Math.round(analysis.longestContinuousSimultaneousSeconds * 10) / 10,
        CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS,
        'how long that unbroken run lasted, CREDITED at most one nominal tick per gap. Wall span of the same '
        + `run: ${Math.round(analysis.longestContinuousWallSeconds * 10) / 10}s`));
      record(args, figure('RC1-simultaneous-totals',
        `${analysis.simultaneousSamples} simultaneous samples in total across ${analysis.simultaneousRuns} `
        + `run(s), ${analysis.brokenByGap} broken by a gap too wide to join. RECORDED; the floors are on the `
        + 'longest unbroken run'));

      for (const server of outcome.perServer) {
        record(args, {
          gate: `RC1-own-barrier-saw-scanner:${server.id}`,
          verdict: server.observedInFlight ? 'pass' : 'fail',
          note: `${server.id}'s own scan barrier saw its own scanner in flight; a scan that started and `
            + 'finished between two polls is a valid completion and NOT an in-flight observation',
        });
      }
      const spread = triggerSpreadSeconds(outcome.triggeredAtMs);
      record(args, figure('RC1-trigger-spread-seconds',
        `${Math.round(spread * 100) / 100}s, RECORDED as a harness health check and deliberately not the `
        + 'concurrency evidence'));
      record(args, figure('RC1-observation-quality',
        `${analysis.samples} samples, ${analysis.pairwiseSamples} with two or more servers scanning, `
        + `${analysis.impreciseSamples} too wide to describe one instant (widest `
        + `${Math.round(analysis.widestSampleSpanSeconds * 100) / 100}s), ${analysis.unreadableSamples} with `
        + 'a server that could not be read'));
      // SCAN DURATION PER SERVER — one of the figures G22 asks for by name, and RECORDED like every other.
      for (const server of outcome.perServer) {
        record(args, figure(`RC1-scan-seconds:${server.id}`,
          `${Math.round(server.elapsedSeconds)}s from trigger to settle, `
          + `${analysis.perServerInFlightSamples[server.id] ?? 0} samples in flight`));
      }
      if (problems.length > 0) {
        for (const problem of problems) console.error(`  ${problem}`);
        fail('the three scans were not observed to overlap, so this window is not the window G18 measured');
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'verify-corpus': {
      // ONE EXPECTATION DOCUMENT, THREE PREDICATES — the same rule G18 holds, for the same reason. The corpus,
      // the sizes and the digests are shared; how each server describes an ordinary file is not, and the one
      // time this repository flattened those three predicates the flattened one matched zero of two correctly
      // catalogued entries.
      const server = need(args, 'server') as ThreeServerId;
      if (!(THREE_SERVER_IDS as readonly string[]).includes(server)) fail(`unknown server "${server}"`);
      const expected = JSON.parse(readFileSync(need(args, 'expect-file'), 'utf8')) as CorpusExpectation[];
      const observed = JSON.parse(readFileSync(need(args, 'catalogue'), 'utf8')) as CatalogueEntry[];

      const selfProblems = corpusSelfProblems(expected);
      if (selfProblems.length > 0) {
        for (const problem of selfProblems) console.error(`  ${problem}`);
        fail('the corpus itself is not fit to assert against');
      }
      record(args, exactly(`RC2-corpus-size:${server}`, expected.length, COMPARISON_CORPUS_ENTRIES,
        'the SAME ~50-entry corpus the product\'s own gates publish; a comparison over a different corpus '
        + 'would be a comparison of corpora'));

      const problems = corpusProblems(expected, observed.map((entry) => ({
        key: entry.key, sizeBytes: entry.sizeBytes, ordinaryFile: entry.ordinaryFile,
      })));
      const whyNot = observed.flatMap((entry) => entry.problems)
        .filter((reason, index, all) => all.indexOf(reason) === index).slice(0, 3);

      record(args, exactly(`RC2-corpus-matched:${server}`, problems.matched, expected.length,
        problems.matched === expected.length
          ? 'identities catalogued at the size recorded outside the mount, as ORDINARY FILES, during the '
            + 'simultaneous scan of the rclone mount'
          : `of what was NOT matched: ${problems.missing} missing, ${problems.wrongSize} at the wrong size, `
            + `${problems.notOrdinary} not ordinary${whyNot.length > 0 ? ` (${whyNot.join('; ')})` : ''}`));
      record(args, exactly(`RC2-corpus-missing:${server}`, problems.missing, 0));
      record(args, exactly(`RC2-corpus-wrong-size:${server}`, problems.wrongSize, 0));
      record(args, exactly(`RC2-corpus-not-ordinary:${server}`, problems.notOrdinary, 0,
        'not a symlink, not a .strm placeholder, not a remote media source: a file on a disk, through a '
        + 'mount whose bytes are not local'));
      record(args, exactly(`RC2-corpus-duplicated:${server}`, problems.duplicated, 0));
      record(args, exactly(`RC2-corpus-unexpected:${server}`, problems.unexpected, 0));
      for (const anchor of expected.filter((entry) => entry.anchor === true)) {
        const found = observed.find((entry) => entry.key === anchor.key);
        record(args, {
          gate: `RC2-anchor:${server}:${opaqueRef('entry', anchor.key).slice(0, 12)}`,
          verdict: found !== undefined && found.sizeBytes === anchor.sizeBytes && found.ordinaryFile
            ? 'pass' : 'fail',
          note: 'an anchor entry, catalogued at the size recorded outside the mount, as an ordinary file',
        });
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'telemetry': {
      // IS THE INSTRUMENT TRUSTWORTHY? Nothing else in this gate is evaluated until this holds, because every
      // figure below is a difference and a difference over a broken counter is a confident wrong number.
      const before = readCounterFile(need(args, 'before'), 'before');
      const after = readCounterFile(need(args, 'after'), 'after');
      const gate = need(args, 'gate');
      const problems = webdavAttributionProblems(before, after, needNumber(args, 'objects'));
      for (const problem of problems.slice(0, 10)) console.error(`  ${problem.kind}: ${problem.detail}`);
      record(args, exactly(`${gate}-telemetry-coherent`, problems.length, 0,
        'no counter fell, both partitions balance on both snapshots, every served byte and every served '
        + 'request is attributed to a registered object, the per-object columns pair by index, and no '
        + 'mutating request reached a read-only endpoint'));
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'cold-window': {
      // WAS THE WINDOW COLD? The cheat this closes is the same one G18 is exposed to by a different mechanism:
      // a client cache that had already been filled answers a scan without reaching the endpoint at all, and
      // the naive path would then be reported as costing a fraction of what it costs — which is a worse
      // failure for a control than an expensive number could ever be.
      const before = readCounterFile(need(args, 'before'), 'before');
      const after = readCounterFile(need(args, 'after'), 'after');
      const gate = need(args, 'gate');
      const firstCorpusOrdinal = needNumber(args, 'first-corpus-ordinal');
      let corpusCommittedBytesBefore = 0;
      let corpusObservedBytesBefore = 0;
      for (let ordinal = firstCorpusOrdinal; ordinal < before.objectCommitted.length; ordinal += 1) {
        corpusCommittedBytesBefore += before.objectCommitted[ordinal] ?? 0;
        corpusObservedBytesBefore += before.objectObserved[ordinal] ?? 0;
      }
      const problems = comparisonColdStateProblems({
        revealedBefore: before.revealed,
        corpusCommittedBytesBefore,
        corpusObservedBytesBefore,
        clientCacheBytesBefore: needNumber(args, 'client-cache-before'),
        getDelta: (after.rangedBodies + after.fullBodies) - (before.rangedBodies + before.fullBodies),
        corpusObjectCount: needNumber(args, 'corpus-objects'),
        heldRequestDelta: after.heldRequests - before.heldRequests,
        holdTimeoutDelta: after.holdTimeouts - before.holdTimeouts,
      });
      for (const problem of problems) console.error(`  ${problem.kind}: ${problem.detail}`);
      record(args, exactly(`${gate}-cold-window`, problems.length, 0,
        'the corpus was visible and had had neither a byte promised nor a byte written for it, the mount '
        + 'client\'s cache directory was empty, the window reached the endpoint at least once per corpus '
        + 'object, and a request really was blocked at the barrier and released rather than lapsing'));
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'measure': {
      // THE COMPARISON ITSELF. EVERY FIGURE BELOW IS RECORDED AND NONE OF THEM IS A THRESHOLD.
      const before = readCounterFile(need(args, 'before'), 'before');
      const after = readCounterFile(need(args, 'after'), 'after');
      const gate = need(args, 'gate');
      const firstCorpusOrdinal = needNumber(args, 'first-corpus-ordinal');
      const measurements = comparisonMeasurements(
        before, after, firstCorpusOrdinal, ordinalList(args, 'product-ordinals'),
      );

      // THE PARTITIONS THAT ARE STILL ASSERTIONS, because a figure that does not add up is not a figure.
      record(args, exactly(`${gate}-committed-bytes-fully-attributed`,
        measurements.unattributedCommittedBytes, 0,
        'corpus plus non-corpus COMMITTED bytes equals the endpoint\'s own total for the window; a shortfall '
        + 'would mean a body was promised for something this gate never registered'));
      record(args, exactly(`${gate}-observed-bytes-fully-attributed`,
        measurements.unattributedObservedBytes, 0,
        'and the same for the OBSERVED column, which is a separate total over the same responses'));
      record(args, atLeast(`${gate}-objects-exercised`, measurements.objectsExercised,
        needNumber(args, 'corpus-objects'),
        'every corpus object was reached at least once. A cost figure over a corpus the scan did not read is '
        + 'a small number for the wrong reason'));

      // ---- THE FIGURES. Recorded. Compared against nothing. ----
      record(args, figure(`${gate}-requests-gets`,
        `${measurements.gets} GETs served a body: ${measurements.rangedGets} carried a Range header and were `
        + `answered 206, ${measurements.fullGets} did not and were answered with a whole body`));
      record(args, figure(`${gate}-requests-metadata`,
        `${measurements.propfind} PROPFIND (${measurements.propfindDepth0} depth-0, `
        + `${measurements.propfindDepth1} depth-1, ${measurements.propfindOther} other), `
        + `${measurements.options} OPTIONS, ${measurements.head} HEAD. This is what a namespace costs when it `
        + 'is DISCOVERED rather than published, and the product\'s topology has no equivalent figure because '
        + 'its namespace arrives in one admitted manifest'));
      record(args, figure(`${gate}-requests-resolution`,
        'ABSENT rather than zero: this topology has no access-resolution step, because the namespace IS the '
        + 'URL space. G14b\'s figure has no counterpart here, and reporting a zero would read as an '
        + 'efficiency rather than as the property ADR 002 rejected the topology for'));
      // TWO BYTE FIGURES, NEVER ONE, AND THE DISTINCTION IS THE CORRECTION THIS GATE MOST NEEDED.
      //
      // COMMITTED is what the responses promised in Content-Length. OBSERVED is what was actually written.
      // An earlier version of this report had only the first and called it "served", which overstates
      // delivery by exactly the amount the client abandoned — and on a corpus built around a ~105 MB fixture,
      // a media server reading a header and closing the handle abandons a great deal.
      record(args, figure(`${gate}-committed-bytes`,
        `${measurements.committedBytes} media bytes COMMITTED — the Content-Length the responses promised, `
        + `not what was delivered — of which ${measurements.corpusCommittedBytes} were for corpus objects and `
        + `${measurements.nonCorpusCommittedBytes} for the readiness canary. A further `
        + `${measurements.metadataBytes} bytes of listing XML are counted SEPARATELY and are folded into `
        + 'neither media total'));
      record(args, figure(`${gate}-observed-bytes`,
        `${measurements.observedBytes} media bytes OBSERVED — the counts the endpoint's Write calls RETURNED, `
        + 'which is an APPLICATION-WRITE observation and NOT peer receipt, NOT a TCP acknowledgement, NOT '
        + 'exact wire bytes and NOT billing '
        + `— of which ${measurements.corpusObservedBytes} were for corpus objects and `
        + `${measurements.nonCorpusObservedBytes} for the readiness canary`));
      record(args, figure(`${gate}-body-outcomes`,
        `${measurements.completedBodies} bodies were written in full and ${measurements.truncatedBodies} `
        + 'were abandoned part-way by the client or failed. A truncated body is the difference between the '
        + 'two byte figures above, and it is a fact about how the client reads rather than a defect'));
      record(args, figure(`${gate}-byte-multiplier`,
        `COMMITTED ${Math.round(measurements.corpusCommittedMultiplier * 1000) / 1000}x and OBSERVED `
        + `${Math.round(measurements.corpusObservedMultiplier * 1000) / 1000}x the corpus's own total length `
        + `of ${measurements.corpusSizeBytes} bytes, for a scan that identified it. THE DENOMINATOR IS NAMED `
        + 'because a multiplier of an unstated quantity is not a measurement, and BOTH numerators are given '
        + 'because a multiplier of an unstated numerator is not one either'));
      record(args, figure(`${gate}-product-comparable-subset`,
        `over the ${PRODUCT_REMOTE_ENTRIES} entries the product serves from its own endpoint: `
        + `${measurements.productComparableCommittedBytes} committed and `
        + `${measurements.productComparableObservedBytes} observed bytes over `
        + `${measurements.productComparableGets} GETs. The other entries are local passthrough on the `
        + 'product\'s topology and remote on this one, so a total-against-total comparison would charge this '
        + 'path for files the product never fetches'));
      record(args, figure(`${gate}-http-429`,
        `${measurements.served429} observed. The endpoint never emits one, so this is a measurement that the `
        + 'client was never rate-limited rather than evidence that it would not be by a real service'));
      record(args, figure(`${gate}-peak-connections`,
        `${measurements.peakConns} connections at the deepest accept, ${measurements.peakConcurrent} requests `
        + 'in flight at once. The connection figure includes this gate\'s own polls of the uncounted counters '
        + 'surface; the in-flight figure does not and is the one that describes the client'));
      record(args, figure(`${gate}-write-attempts`,
        `${measurements.writeAttempts} mutating WebDAV requests reached a read-only endpoint`));

      // PER OBJECT, IN TWO ORDERINGS, BECAUSE THEY NAME DIFFERENT OBJECTS AND BOTH ARE THE FINDING.
      //
      // An aggregate is exactly where one file read many times over hides — and on this topology that is the
      // expected shape rather than a defect to be caught, so it is reported rather than refused. WORST
      // MULTIPLIER first names the object the topology treated worst relative to its size. MOST BYTES first
      // names where the traffic actually went, which on a corpus carrying one ~105 MB fixture is a different
      // object entirely: a large object at a modest multiple can be most of the window while sitting nowhere
      // near the top of the multiplier list, and reporting only the first ordering would leave the biggest
      // single contributor to the headline total unnamed.
      const describeCost = (label: string, cost: typeof measurements.perObject[number]): void => {
        record(args, figure(`${gate}-object-cost-${label}:#${cost.ordinal}`,
          `${cost.committedBytes} committed and ${cost.observedBytes} observed bytes over ${cost.gets} GETs `
          + `(${cost.rangedGets} ranged, ${cost.fullGets} whole-body) for an object of ${cost.sizeBytes} `
          + `bytes: ${Math.round(cost.committedMultiplier * 1000) / 1000}x committed and `
          + `${Math.round(cost.observedMultiplier * 1000) / 1000}x observed, of its own length`));
      };
      for (const cost of measurements.perObject.filter((entry) => entry.gets > 0).slice(0, 5)) {
        describeCost('by-multiplier', cost);
      }
      for (const cost of measurements.perObjectByBytes.filter((entry) => entry.gets > 0).slice(0, 3)) {
        describeCost('by-bytes', cost);
      }

      // THE THIRD INSTRUMENT, ON THE OTHER SIDE OF THE WIRE, READ AS STRICTLY AS THE FIRST TWO.
      //
      // THE PERSISTED SNAPSHOTS GO THROUGH THE SAME PARSER THE LIVE READ USES. An earlier version did
      // `Number(value ?? 0)` here, which turns a missing field into a confident zero — and a zero in this
      // position does not read as "unknown", it reads as "the client transferred nothing", which is the most
      // dramatic possible version of the claim this figure was being used to make.
      const clientBefore = readClientStatsFile(need(args, 'client-stats-before'), 'before');
      const clientAfter = readClientStatsFile(need(args, 'client-stats-after'), 'after');
      const clientResets = clientStatsProblems(clientBefore, clientAfter);
      for (const problem of clientResets) console.error(`  ${problem.kind}: ${problem.detail}`);
      record(args, exactly(`${gate}-client-telemetry-coherent`, clientResets.length, 0,
        'the mount client\'s own lifetime totals did not fall across the window, so their difference '
        + 'describes one mount process rather than two'));
      const clientBytes = clientAfter.bytes - clientBefore.bytes;
      const clientTransfers = clientAfter.transfers - clientBefore.transfers;
      record(args, figure(`${gate}-client-own-accounting`,
        `the mount client accounts for ${clientBytes} bytes over ${clientTransfers} transfers, against `
        + `${measurements.committedBytes} committed and ${measurements.observedBytes} observed at the `
        + 'endpoint. THESE ARE THREE DIFFERENT MEASUREMENTS and none is corrected to match another: the '
        + 'endpoint promised the first, wrote the second, and the client believes it passed the third '
        + 'upward. NO RATIO BETWEEN THEM IS A PROVIDER COST — committed-minus-observed is the endpoint\'s '
        + 'own optimism about reads the client abandoned, and observed-minus-client is read-ahead and '
        + 'discard, and the two have different causes'));
      record(args, figure(`${gate}-client-cache`,
        `the client's cache directory held ${needNumber(args, 'client-cache-before')} bytes before the window `
        + `and ${needNumber(args, 'client-cache-after')} after it`));
      record(args, figure(`${gate}-client-bounds`,
        `the client was configured with an IO deadline of ${RCLONE_TIMEOUTS_MS.IO_IDLE}ms and a connect `
        + `deadline of ${RCLONE_TIMEOUTS_MS.CONNECT}ms, both set explicitly so that no figure above can be `
        + 'attributed to a deadline this gate imposed'));

      // WHAT WAS UNDER TEST, EMITTED INTO THE REPORT so a reader of the results file alone can tell which
      // topology produced these numbers.
      record(args, figure(`${gate}-topology`, RCLONE_COMPARISON_TOPOLOGY.join(' -> ')));
      record(args, figure(`${gate}-per-server-attribution`,
        'NOT CLAIMED. One mount client serves all three media servers, so the endpoint sees the client and '
        + 'never the server behind a byte. Every figure above is attributed to an OBJECT; none is attributed '
        + 'to a server. What is per-server is the catalogue evidence and the overlap evidence'));
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'nonclaims': {
      for (const claim of RCLONE_COMPARISON_NONCLAIMS) console.log(`  - ${claim}`);
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'report': {
      const path = need(args, 'results');
      if (!existsSync(path)) fail('there are no results to report, which is itself a failure');
      const results = JSON.parse(readFileSync(path, 'utf8')) as GateResult[];
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
      console.log(`Projection Phase 1 — G22 rclone/WebDAV comparison control: ${results.length} assertions, `
        + `${failed.length} failed, ${skipped.length} skipped.`);
      for (const result of results) {
        const measured = result.measured === undefined ? '' : ` ${result.measured}/${result.budget}`;
        console.log(`  ${result.verdict.padEnd(4)} ${result.gate}${measured}`);
      }
      const jsonOut = args.flags.get('json');
      if (jsonOut !== undefined) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);

      // A SKIPPED ASSERTION IS NOT A SUCCESS, AND THAT IS TRUE OF A GATE WITH NO THRESHOLDS TOO. G22 declines
      // to judge the COST; it does not decline to judge whether it measured anything. An assertion that
      // skipped is a question this gate did not answer, and a run that exited zero over one would be
      // publishing a comparison it does not have.
      if (failed.length > 0 || skipped.length > 0) {
        if (skipped.length > 0 && failed.length === 0) {
          console.error(`${skipped.length} assertion(s) SKIPPED and none failed. A skipped assertion is a `
            + 'question the gate declined to answer, and a comparison assembled out of unanswered questions '
            + 'is worse than none.');
          for (const result of skipped.slice(0, 10)) console.error(`  skip ${result.gate}`);
        }
        process.exit(1);
      }
      return;
    }

    case 'redaction-check': {
      const path = need(args, 'file');
      if (!existsSync(path)) fail('a kept artifact does not exist');
      const problems = findRedactionProblems(JSON.parse(readFileSync(path, 'utf8')));
      if (problems.length > 0) {
        for (const problem of problems.slice(0, 20)) console.error(`  ${problem.kind} at ${problem.at}`);
        fail('a kept artifact is not redaction-safe');
      }
      console.log('  redaction-safe');
      return;
    }

    case 'objects': {
      // The endpoint's own registration document, read back so the shell can assert the corpus it published
      // is the corpus the endpoint is serving, before anything has read one byte through a mount.
      const objects = readRegisteredObjects(need(args, 'file'));
      const field = need(args, 'field');
      const wanted = need(args, 'ref');
      const object = objects.find((entry) => entry.ref === wanted);
      if (object === undefined) fail('no such registered object');
      if (field === 'size') console.log(String(object.size));
      else if (field === 'sha256') console.log(object.sha256);
      else if (field === 'path') console.log(object.path);
      else fail(`unknown field "${field}"`);
      return;
    }

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof GateFailure) {
    console.error(`projection-rclone-comparison: ${error.message}`);
    process.exit(1);
  }
  console.error(`projection-rclone-comparison: ${(error as Error).message}`);
  process.exit(1);
});
