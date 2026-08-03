import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MEDIA_SERVER_BUDGETS, corpusProblems, corpusSelfProblems, exactly, findRedactionProblems, opaqueRef,
  atLeast, withinBudget, type CorpusExpectation, type GateResult,
} from '../core/projection/media-server-dataplane.js';
import { PROJECTIOND_ADMISSION_LIMITS } from '../core/projection/runtime-contract.js';
import {
  CONCURRENCY_DEADLINES_MS, CONCURRENCY_RULES, HOLD_ARM_MS, REQUIRED_SERVER_COUNT, THREE_SERVER_IDS,
  THREE_SERVER_NONCLAIMS, analyseOverlap, attributionProblems, breachedObjects, coldStateProblems,
  breachedShapes, corpusAttribution, daemonBlockByteCeiling, objectByteVerdicts, objectShapeVerdicts,
  overlapProblems, parseProviderCounters, triggerSpreadSeconds,
  type OverlapSample, type ProviderCounters, type ThreeServerId,
} from '../core/projection/three-server-concurrency.js';
import { PLEX_LARGE_FIXTURE, PLEX_SCAN_ENVELOPE } from '../core/projection/plex-dataplane.js';
import {
  adapterFor, readCounters, readExpected, runConcurrentScans, setHold,
  type CatalogueEntry, type ConcurrentScanOutcome,
} from './projection-three-server-concurrency.js';

// The Projection Phase 1 THREE-SERVER HIGH-CONCURRENCY SCAN gate (G18), from the command line.
//
// WHAT G18 IS: "All three servers scanning simultaneously: G14a–G17 still hold, unchanged."
// (`docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5.)
//
// THE BUDGETS ARE NOT RESTATED HERE. `MEDIA_SERVER_BUDGETS` is imported and used exactly as the three
// single-server gates use it, because "unchanged" is the word the plan uses and a combined gate that
// redefined a ceiling would be measuring something else and calling it G18.
//
//   concurrent-scan   --state-emby F --state-jellyfin F --state-plex F --endpoint U --barrier-ref R
//                     --out F --catalogue-dir D [--sample-interval-ms N] [--hold-arm-ms N]
//   verify-overlap    --scan F
//   verify-corpus     --server ID --catalogue F --expect-file F
//   counters          --url U --out F
//   window            --before F --after F --gate G --large-bytes N --small-bytes N --remote-entries N
//                     --objects N --probe-cache-before N [--windows N]
//   provider-invariants --counters F --gate G
//   nonclaims
//   report            --results F [--json F]        redaction-check --file F
//
// EVERY PHASE APPENDS ITS VERDICTS to one results file, and `report` prints them, holds them against the
// acceptance plan's redaction rule, and exits non-zero if any gate failed.

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
  console.error(`projection-three-server-concurrency: ${message}`);
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
  // A FAILED VERDICT STOPS THE PHASE IMMEDIATELY. Continuing would produce a run whose later measurements
  // were taken against a state the gate had already declared wrong.
  if (result.verdict === 'fail') throw new GateFailure(`${result.gate} failed`);
}

/** Read a counters document, refusing anything a budget could not honestly be asserted over. */
function readCounterFile(path: string, label: string): ProviderCounters {
  const parsed = parseProviderCounters(JSON.parse(readFileSync(path, 'utf8')), label);
  if (parsed.counters === undefined) {
    for (const problem of parsed.problems.slice(0, 10)) console.error(`  ${problem.kind}: ${problem.detail}`);
    fail(`the ${label} counters document cannot support a budget`);
  }
  return parsed.counters;
}

function readScanOutcome(path: string): ConcurrentScanOutcome {
  return JSON.parse(readFileSync(path, 'utf8')) as ConcurrentScanOutcome;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    // -----------------------------------------------------------------------------------------------------
    case 'concurrent-scan': {
      // THE ONE PHASE THAT COULD NOT BE THREE PHASES.
      //
      // Every other assertion in this gate could be made by running the three existing gates' commands one
      // after another. This one cannot: whether three scans overlapped is a property of one clock watching
      // three servers, and three processes that each watched one server would have three clocks and no way
      // to relate them. So the triggers, the observation and the barrier release all live here.
      const adapters = THREE_SERVER_IDS.map((id) => adapterFor(id));
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
        holdArmMs: optionalNumber(args, 'hold-arm-ms', HOLD_ARM_MS),
        onNote: (message) => console.log(`  ${message}`),
      });

      // THE CATALOGUE IS READ ONCE PER SERVER, AFTER EVERY SCAN HAS SETTLED, THROUGH EACH SERVER'S OWN
      // LISTING. Reading it inside each scan would compare three libraries taken at three different moments,
      // and the differences would be attributed to the data plane rather than to the clock.
      const catalogueDir = need(args, 'catalogue-dir');
      ensureDir(catalogueDir);
      for (const adapter of adapters) {
        const entries = await adapter.catalogue(states.get(adapter.id));
        writeFileSync(`${catalogueDir}/catalogue-${adapter.id}.json`,
          `${JSON.stringify(entries, null, 2)}\n`);
      }
      writeFileSync(need(args, 'out'), `${JSON.stringify(outcome, null, 2)}\n`);

      const failures = outcome.perServer.filter((server) => server.failure !== undefined);
      for (const server of failures) {
        console.error(`  the ${server.id} scan failed: ${server.failure}`);
      }
      if (failures.length > 0) fail(`${failures.length} of ${adapters.length} concurrent scans failed`);
      console.log(`  ${adapters.length} concurrent scans completed; `
        + `${outcome.timeline.length} observation samples recorded`);
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'verify-overlap': {
      // WHERE THE WORD "SIMULTANEOUSLY" IS EITHER EARNED OR NOT.
      const outcome = readScanOutcome(need(args, 'scan'));
      const analysis = analyseOverlap(outcome.timeline as OverlapSample[], THREE_SERVER_IDS);
      const problems = overlapProblems(analysis);

      record(args, exactly('TS1-servers-observed-scanning', analysis.serversObservedInFlight,
        REQUIRED_SERVER_COUNT,
        'each server\'s OWN present-tense answer, not "we asked it and have not seen it stop"'));
      record(args, atLeast('TS1-max-servers-in-flight-at-once', analysis.maxServersInFlight,
        REQUIRED_SERVER_COUNT,
        'one would be what three SEQUENTIAL scans look like, and three sequential scans is what this gate '
        + 'exists to refuse'));
      record(args, atLeast('TS1-simultaneous-samples', analysis.simultaneousSamples,
        CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES,
        'samples in which every server was scanning at the same instant; a tick whose three answers were '
        + `more than ${CONCURRENCY_DEADLINES_MS.SAMPLE_MAX_SPAN}ms apart is not one instant and does not count`));
      record(args, atLeast('TS1-simultaneous-span-seconds',
        Math.round(analysis.simultaneousSpanSeconds * 10) / 10,
        CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS,
        'first to last three-way sample; an instantaneous graze is not "scanning simultaneously"'));

      // EVERY SERVER'S OWN BARRIER ALSO SAW ITS OWN SCANNER RUNNING, which is a SECOND, INDEPENDENT witness.
      // The observer above polls from outside; each driver's `ScanBarrier` watches from inside its own scan
      // and refuses a fast-complete. Requiring both means a single broken instrument cannot carry the claim.
      for (const server of outcome.perServer) {
        record(args, {
          gate: `TS1-own-barrier-saw-scanner:${server.id}`,
          verdict: server.observedInFlight ? 'pass' : 'fail',
          note: `${server.id}'s own scan barrier saw its own scanner in flight; a scan that started and `
            + `finished between two polls is a valid completion and NOT an in-flight observation`,
        });
      }

      // RECORDED, NOT THE CLAIM. See TRIGGER_SPREAD_IS_NOT_OVERLAP_EVIDENCE: three triggers landing together
      // says nothing about whether the three scans then overlapped, and a gate that rested on it would be
      // reporting a concurrency it never observed.
      const spread = triggerSpreadSeconds(outcome.triggeredAtMs);
      record(args, withinBudget('TS1-trigger-spread-seconds', Math.round(spread * 100) / 100,
        CONCURRENCY_RULES.MAX_TRIGGER_SPREAD_SECONDS,
        'RECORDED as a harness health check, and deliberately not the concurrency evidence: three triggers '
        + 'landing inside a second is perfectly compatible with three scans that never overlapped'));
      record(args, {
        gate: 'TS1-observation-quality', verdict: 'pass',
        note: `${analysis.samples} samples, ${analysis.pairwiseSamples} with two or more servers scanning, `
          + `${analysis.impreciseSamples} too wide to describe one instant (widest `
          + `${Math.round(analysis.widestSampleSpanSeconds * 100) / 100}s), `
          + `${analysis.unreadableSamples} with a server that could not be read`,
      });
      for (const server of outcome.perServer) {
        record(args, {
          gate: `TS1-scan-seconds:${server.id}`, verdict: 'pass',
          note: `${Math.round(server.elapsedSeconds)}s from trigger to settle, `
            + `${analysis.perServerInFlightSamples[server.id] ?? 0} samples in flight`,
        });
      }
      if (problems.length > 0) {
        for (const problem of problems) console.error(`  ${problem}`);
        fail('the three scans were not observed to overlap');
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'verify-corpus': {
      // ONE SERVER'S VIEW OF THE SHARED CORPUS, THROUGH ITS OWN ORDINARY-FILE PREDICATE.
      //
      // THE EXPECTATION IS THE SAME DOCUMENT FOR ALL THREE, which is half of what makes this G18 rather than
      // three gates in a trench coat: same mount, same admitted generation, same ~50 identities, same
      // published sizes. What differs per server is only how that server describes a file, and those three
      // descriptions are deliberately not unified.
      const server = need(args, 'server') as ThreeServerId;
      if (!(THREE_SERVER_IDS as readonly string[]).includes(server)) fail(`unknown server "${server}"`);
      const expected = readExpected(need(args, 'expect-file')) as CorpusExpectation[];
      const observed = JSON.parse(readFileSync(need(args, 'catalogue'), 'utf8')) as CatalogueEntry[];

      const selfProblems = corpusSelfProblems(expected);
      if (selfProblems.length > 0) {
        for (const problem of selfProblems) console.error(`  ${problem}`);
        fail('the corpus itself is not fit to assert against');
      }

      const problems = corpusProblems(expected, observed.map((entry) => ({
        key: entry.key, sizeBytes: entry.sizeBytes, ordinaryFile: entry.ordinaryFile,
      })));
      const whyNot = observed.flatMap((entry) => entry.problems)
        .filter((reason, index, all) => all.indexOf(reason) === index).slice(0, 3);

      record(args, exactly(`TS2-corpus-matched:${server}`, problems.matched, expected.length,
        problems.matched === expected.length
          ? 'published identities catalogued at the published size as ordinary files, during the '
            + 'simultaneous scan'
          : `of what was NOT matched: ${problems.missing} missing, ${problems.wrongSize} at the wrong size, `
            + `${problems.notOrdinary} not ordinary${whyNot.length > 0 ? ` (${whyNot.join('; ')})` : ''}`));
      record(args, exactly(`TS2-corpus-missing:${server}`, problems.missing, 0));
      record(args, exactly(`TS2-corpus-wrong-size:${server}`, problems.wrongSize, 0));
      record(args, exactly(`TS2-corpus-not-ordinary:${server}`, problems.notOrdinary, 0,
        'not a symlink, not a .strm placeholder, not a remote media source: a file on a disk'));
      record(args, exactly(`TS2-corpus-duplicated:${server}`, problems.duplicated, 0));
      record(args, exactly(`TS2-corpus-unexpected:${server}`, problems.unexpected, 0));
      // THE ANCHORS, INDIVIDUALLY. The aggregate above is a count of matches and cannot be satisfied by
      // fifty arbitrary items; these say that the specific entries whose bytes were digested outside the
      // mount are among them, named by digest rather than by path.
      for (const anchor of expected.filter((entry) => entry.anchor === true)) {
        const found = observed.find((entry) => entry.key === anchor.key);
        record(args, {
          gate: `TS2-anchor:${server}:${opaqueRef('entry', anchor.key).slice(0, 12)}`,
          verdict: found !== undefined && found.sizeBytes === anchor.sizeBytes && found.ordinaryFile
            ? 'pass' : 'fail',
          note: 'an anchor entry, catalogued at the size the control plane published, as an ordinary file',
        });
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'counters': {
      const snapshot = await readCounters(need(args, 'url'));
      writeFileSync(need(args, 'out'), `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log('  counters recorded');
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'hold': {
      // The barrier, driven from the shell for the phases that need it outside a scan.
      await setHold(need(args, 'endpoint'), need(args, 'ref'), need(args, 'held') === 'true');
      console.log(`  the barrier object is now ${need(args, 'held') === 'true' ? 'held' : 'released'}`);
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'window': {
      // G14a–G17 OVER THE SIMULTANEOUS SCAN, UNCHANGED, PLUS THE THREE THINGS THAT MAKE THEM READABLE.
      //
      // THE ORDER IS THE ARGUMENT:
      //   1. IS THE INSTRUMENT TRUSTWORTHY? A reset or missing counter makes every ceiling below pass by
      //      reading zero, so nothing else is evaluated until this holds.
      //   2. WAS THE WINDOW COLD? A warm cache makes a scan cost the provider nothing, which scores
      //      perfectly against every ceiling. This is the cheat G18 is most exposed to, because G19 says a
      //      re-scan legitimately costs zero.
      //   3. ...and only then the budgets, and only then per object.
      const before = readCounterFile(need(args, 'before'), 'before');
      const after = readCounterFile(need(args, 'after'), 'after');
      const gate = need(args, 'gate');
      const objects = needNumber(args, 'objects');
      const remoteEntries = needNumber(args, 'remote-entries');
      const largeBytes = needNumber(args, 'large-bytes');
      const smallBytes = needNumber(args, 'small-bytes');
      const windows = optionalNumber(args, 'windows', MEDIA_SERVER_BUDGETS.MAX_SCAN_RANGE_MULTIPLIER);
      const probeCacheBefore = needNumber(args, 'probe-cache-before');
      const delta = (key: keyof ProviderCounters): number =>
        (after[key] as number) - (before[key] as number);

      // 1. THE INSTRUMENT.
      const attribution = attributionProblems(before, after, objects);
      record(args, exactly(`${gate}-telemetry-coherent`, attribution.length, 0,
        attribution.length === 0
          ? 'no counter reset, both request partitions exact, and every served byte attributed to a '
            + 'registered corpus object'
          : attribution.slice(0, 3).map((problem) => `${problem.kind}: ${problem.detail}`).join(' | ')));

      // 1b. EVERY BYTE BELONGS TO THE SHARED CORPUS.
      //
      // The endpoint registers one object this gate never publishes — the canary the readiness probe reads,
      // so that proving the endpoint answers a ranged request correctly does not put bytes on a corpus
      // object and destroy the cold-window measurement before it starts. It sits at registration ordinal 0,
      // the corpus follows it, and this splits the window between them exactly.
      const firstCorpusOrdinal = optionalNumber(args, 'non-corpus-objects', 1);
      const attributed = corpusAttribution(before, after, firstCorpusOrdinal);
      record(args, exactly(`${gate}-bytes-unattributed`, attributed.unattributed, 0,
        'the endpoint\'s own total, less what it attributes to registered objects. Anything but zero is a '
        + 'body served for a reference this gate never registered'));
      record(args, exactly(`${gate}-bytes-outside-the-corpus`, attributed.otherBytes, 0,
        `every one of the ${attributed.corpusBytes} bytes this window cost belongs to an object in the `
        + 'SHARED corpus the three servers scanned; the readiness canary took none of them'));

      // 2. THE WINDOW WAS COLD.
      const cold = coldStateProblems({
        probeCacheBytesBefore: probeCacheBefore,
        corpusBytesBefore: attributed.corpusBytesBefore,
        rangeRequestDelta: delta('rangeRequests'),
        remoteObjectCount: remoteEntries,
        heldRequestDelta: delta('heldRequests'),
        holdTimeoutDelta: delta('holdTimeouts'),
      });
      record(args, exactly(`${gate}-cold-window`, cold.length, 0,
        cold.length === 0
          ? `the daemon held no scan-window cache before the scan, ${delta('rangeRequests')} ranged GETs `
            + `covered ${remoteEntries} uncached remote entries, and ${delta('heldRequests')} provider `
            + 'request(s) were actually blocked at the barrier'
          : cold.map((problem) => `${problem.kind}: ${problem.detail}`).join(' | ')));

      // 3. G14a, G14b, G15, G16, G17 — the same budgets the three single-server gates hold, unchanged.
      record(args, withinBudget(`${gate}-G14a-range-requests`, delta('rangeRequests'),
        Math.ceil(remoteEntries * windows),
        `denominator: ${remoteEntries} remote entries x ${windows} windows. ONE denominator for three `
        + 'servers, because one daemon serves all three and its scan-window cache is what the second and '
        + 'third scan read from — a 3x denominator would be a budget nothing could ever breach'));
      record(args, withinBudget(`${gate}-G14b-resolutions`, delta('resolutions'),
        Math.ceil(remoteEntries * MEDIA_SERVER_BUDGETS.MAX_SCAN_RESOLUTION_MULTIPLIER),
        `denominator: ${remoteEntries} remote entries`));
      // G15, AGGREGATE, AND EVERY TERM OF ITS DENOMINATOR NAMED.
      //
      // THE AGGREGATE IS THE SUM OF THE PER-OBJECT CEILINGS, NOT A MULTIPLIER OVER A POOLED SIZE. A pooled
      // denominator lets the large entries pay for the small ones, which is how a corpus scan of tiny files
      // can hide a large object being downloaded whole. The per-object ceilings are computed below, from the
      // daemon's own block geometry and — on the large fixture, where it is the tighter bound — from the
      // byte fraction that carries the product's whole argument.
      const perObject = objectByteVerdicts(before, after, daemonBlockByteCeiling,
        PLEX_LARGE_FIXTURE.MIN_BYTES, MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION);
      const aggregateCeiling = perObject.reduce((total, verdict) => total + verdict.ceilingBytes, 0);
      record(args, withinBudget(`${gate}-G15-provider-bytes`, delta('bytesServed'), aggregateCeiling,
        `denominator: the sum of every registered object's own ceiling. ${largeBytes} bytes sit above the `
        + `single-probe threshold and ${smallBytes} below it; the large fixture is held to the `
        + `x${MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION} fraction, everything else to `
        + `${REQUIRED_SERVER_COUNT}x the daemon's own per-object block envelope`));
      record(args, withinBudget(`${gate}-G16-http-429`, delta('served429'),
        MEDIA_SERVER_BUDGETS.MAX_HTTP_429, 'not "few". Zero — a 429 means the admission limits did not hold'));
      record(args, withinBudget(`${gate}-full-body-on-range`, delta('fullBodyServed'),
        MEDIA_SERVER_BUDGETS.MAX_FULL_BODY_SERVED));

      // G17, TWICE, WITH BOTH DENOMINATORS NAMED AND NEITHER PRETENDING TO BE THE OTHER.
      //
      // `peakConcurrent` is in-flight RANGED REQUESTS, and it is the daemon's own per-endpoint admission cap
      // measured at the endpoint. Nothing but the daemon's reads reaches it: `/counters` and `/control/*` do
      // not go through the range path at all.
      //
      // `peakConns` is sampled on every ACCEPT, which is the sampling point G17 names — and it therefore also
      // counts THIS GATE's own connections to `/counters`. That is why its ceiling is the looser
      // MAX_PEAK_CONNECTIONS rather than the admission cap: judging the daemon against a number that includes
      // the harness would be judging the harness.
      record(args, withinBudget(`${gate}-G17-peak-concurrent-provider-reads`, after.peakConcurrent,
        PROJECTIOND_ADMISSION_LIMITS.PER_ENDPOINT_MAX_INFLIGHT_REQUESTS,
        'the CONFIGURED per-endpoint in-flight cap, observed at the endpoint. Only the daemon\'s ranged '
        + 'requests reach this counter'));
      record(args, withinBudget(`${gate}-G17-peak-connections-on-accept`, after.peakConns,
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS,
        'sampled at the server on every accept, as G17 says. It also counts this gate\'s own connections to '
        + 'the uncounted /counters surface, which is why the ceiling is the looser of the two'));

      // 4. PER OBJECT, WHICH IS WHERE AN AGGREGATE PASS HIDES A BREACH.
      const breached = breachedObjects(perObject);
      const exercised = perObject.filter((verdict) => verdict.servedBytes > 0);
      record(args, exactly(`${gate}-G15-per-object-breaches`, breached.length, 0,
        breached.length === 0
          ? `${exercised.length} of ${perObject.length} registered objects were read during the window, each `
            + 'within a ceiling derived from its OWN length'
          : breached.slice(0, 3).map((verdict) => `object #${verdict.ordinal} read `
            + `${verdict.servedBytes} of its own ${verdict.sizeBytes} bytes `
            + `(x${Math.round(verdict.multiplier * 1000) / 1000}) against a ${verdict.boundKind} ceiling of `
            + `${verdict.ceilingBytes}`).join(' | ')));
      record(args, atLeast(`${gate}-objects-exercised`, exercised.length, remoteEntries,
        'every remote entry the servers catalogued had to be fetched at least once from a cold cache; '
        + 'an object with zero traffic satisfies its ceiling by having had nothing happen to it'));

      // THE ONE ASSERTION THAT ACTUALLY REQUIRES THE THREE SCANS TO HAVE SHARED A CACHE.
      //
      // On the large fixture the byte fraction is the binding bound, and three independent scanners each
      // paying the full single-scanner envelope would BREACH it. So passing this is not a restatement of the
      // per-object check above — it is the statement that the second and third concurrent scans read from
      // what the first one cached rather than fetching the object again.
      const largeFixtures = perObject.filter((verdict) => verdict.boundKind === 'byte-fraction');
      record(args, atLeast(`${gate}-large-fixture-present`, largeFixtures.length, 1,
        `an object at or above ${PLEX_LARGE_FIXTURE.MIN_BYTES} bytes, which is where the `
        + `x${MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION} fraction becomes the tighter bound and the claim `
        + 'becomes testable. Without one the whole corpus is judged only by block geometry'));
      for (const fixture of largeFixtures) {
        record(args, withinBudget(`${gate}-G15-large-fixture-fraction`, fixture.servedBytes,
          fixture.ceilingBytes,
          `${Math.round(fixture.multiplier * 1000) / 1000}x of the object's own length. THREE scanners each `
          + `paying a full envelope would be ${REQUIRED_SERVER_COUNT * daemonBlockByteCeiling(fixture.sizeBytes)}`
          + ' bytes and would breach this, so passing it means the second and third scans read what the '
          + 'first one cached'));
      }

      // THE SHARING RATIO, RECORDED AND ASSERTED ON BY NOTHING. It is what the window cost as a share of the
      // three-independent-scanner worst case, and a floor or ceiling on it would be asserting an efficiency
      // this gate has very few observations of.
      const worstCase = perObject.reduce(
        (total, verdict) => total + REQUIRED_SERVER_COUNT * daemonBlockByteCeiling(verdict.sizeBytes), 0);
      record(args, {
        gate: `${gate}-sharing-ratio`, verdict: 'pass',
        note: `${delta('bytesServed')} bytes against a ${worstCase}-byte worst case for `
          + `${REQUIRED_SERVER_COUNT} independent scanners: `
          + `${worstCase > 0 ? Math.round((delta('bytesServed') / worstCase) * 1000) / 1000 : 0}. RECORDED, `
          + 'asserted on by nothing',
      });

      // 5. THE PER-ENTRY REQUEST SHAPE, WHICH BYTES CANNOT DESCRIBE.
      const shapes = objectShapeVerdicts(before, after,
        PLEX_SCAN_ENVELOPE.BLOCK, PLEX_SCAN_ENVELOPE.SMALL);
      const badShapes = breachedShapes(shapes);
      record(args, exactly(`${gate}-per-entry-request-shape`, badShapes.length, 0,
        badShapes.length === 0
          ? `every object's block-class and probe-window response counts stayed inside `
            + `${REQUIRED_SERVER_COUNT}x the daemon's own per-entry envelope, with zero OVERSIZED responses`
          : badShapes.slice(0, 3).map((verdict) => `object #${verdict.ordinal}: `
            + `${verdict.blockResponses}/${verdict.blockCeiling} block-class, `
            + `${verdict.smallResponses}/${verdict.smallCeiling} probe-window, `
            + `${verdict.oversizedResponses} oversized`).join(' | ')));
      record(args, exactly(`${gate}-oversized-responses`, delta('oversizedResponses'), 0,
        'a body larger than a demand block is a coalesced read or a full body answering a ranged request. '
        + 'Never observed in nineteen instrumented windows, and three servers do not make one legitimate'));
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'provider-invariants': {
      // ABSOLUTE, NOT A DELTA. These hold for the WHOLE run, not merely across some window of it.
      const snapshot = readCounterFile(need(args, 'counters'), 'final');
      const gate = need(args, 'gate');
      record(args, withinBudget(`${gate}-http-429-total`, snapshot.served429,
        MEDIA_SERVER_BUDGETS.MAX_HTTP_429, 'across the whole run'));
      record(args, withinBudget(`${gate}-full-body-total`, snapshot.fullBodyServed,
        MEDIA_SERVER_BUDGETS.MAX_FULL_BODY_SERVED, 'across the whole run'));
      record(args, withinBudget(`${gate}-peak-connections-total`, snapshot.peakConns,
        MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS, 'across the whole run, sampled on every accept'));
      record(args, withinBudget(`${gate}-peak-concurrent-reads-total`, snapshot.peakConcurrent,
        PROJECTIOND_ADMISSION_LIMITS.PER_ENDPOINT_MAX_INFLIGHT_REQUESTS,
        'across the whole run, against the configured per-endpoint in-flight cap'));
      record(args, exactly(`${gate}-holds-lapsed-total`, snapshot.holdTimeouts, 0,
        'a lapsed hold is a provider read stalled for the whole hold budget rather than released'));
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'nonclaims': {
      // PRINTED FROM THE CONSTANT, NOT RETYPED IN THE SHELL. The offline suite asserts that the gate script
      // prints these through this command rather than in prose somebody could quietly soften.
      for (const claim of THREE_SERVER_NONCLAIMS) console.log(`  - ${claim}`);
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
      console.log(`Projection Phase 1 — G18 three-server concurrent scan: ${results.length} assertions, `
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

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof GateFailure) {
    console.error(`projection-three-server-concurrency: ${error.message}`);
    process.exit(1);
  }
  console.error(`projection-three-server-concurrency: ${(error as Error).message}`);
  process.exit(1);
});
