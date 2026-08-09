/**
 * MEASUREMENT MODE FOR THE CONTINUOUS-OVERLAP OBSERVATION — and the proof that it relaxes nothing else.
 *
 * WHY IT EXISTS. The Phase 2 multi-frontend harness aborted arm A at `TS1-continuous-simultaneous-samples`:
 * observed 1 against an inherited floor of 3. On Unraid, `projectiond` serves the scan window from its probe
 * cache, so its three scans never queue behind the provider and finish closer together than an rclone arm's
 * do — the barrier blocked for **0 s**. The length of that overlap is the quantity the harness exists to
 * COMPARE between frontends, and a harness that aborts on the figure it exists to report cannot report it.
 *
 * WHAT THIS SUITE IS FOR. Measurement mode is a relaxation, and a relaxation is only safe if it cannot
 * spread. Every test below is about containment: the strict interpretation is untouched and still fails,
 * only an explicit opt-in reaches the relaxed one, the relaxed one still fails closed on an observation that
 * did not happen, and no other caller can inherit it by default, by typo, or by omission.
 *
 * THE ANALYSIS IS DRIVEN, NOT IMITATED. Every fixture goes through the shipped `analyseOverlap`, so these
 * tests exercise the same path the gates do rather than a hand-built struct that could drift from it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONCURRENCY_RULES, OVERLAP_MEASUREMENT_NONCLAIM, OVERLAP_MODE_DEFAULT, REQUIRED_SERVER_COUNT,
  THREE_SERVER_IDS, analyseOverlap, measurementClosureProblems, overlapProblems, parseOverlapMode,
  type OverlapSample,
} from '../src/core/projection/three-server-concurrency.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push([name, error]);
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const TICK = 500;

/** A tick in which every named server is scanning, readable and precise. */
function allScanning(atMs: number): OverlapSample {
  return {
    atMs, spanMs: 20,
    inFlight: Object.fromEntries(THREE_SERVER_IDS.map((id) => [id, true])),
    unreadable: [],
  };
}

/** A tick in which only the first server is scanning — the shape of three SEQUENTIAL scans. */
function oneScanning(atMs: number): OverlapSample {
  return {
    atMs, spanMs: 20,
    inFlight: Object.fromEntries(THREE_SERVER_IDS.map((id, index) => [id, index === 0])),
    unreadable: [],
  };
}

/** A tick nobody could be read in — the shape of an observer talking to nothing. */
function unreadable(atMs: number): OverlapSample {
  return {
    atMs, spanMs: 20,
    inFlight: Object.fromEntries(THREE_SERVER_IDS.map((id) => [id, false])),
    unreadable: [...THREE_SERVER_IDS],
  };
}

const analyse = (timeline: readonly OverlapSample[]) => analyseOverlap(timeline, THREE_SERVER_IDS);

console.log('Projection — overlap measurement mode (offline)');

// -----------------------------------------------------------------------------------------------------------
// THE PHASE 1 INTERPRETATION IS UNTOUCHED.
// -----------------------------------------------------------------------------------------------------------

test('THE DEFAULT IS STRICT, so a caller that says nothing gets the acceptance interpretation', () => {
  assert(OVERLAP_MODE_DEFAULT === 'strict', 'the default overlap mode is no longer strict');
  assert(parseOverlapMode(undefined) === 'strict', 'an absent mode no longer resolves to strict');
  assert(parseOverlapMode('') === 'strict', 'an empty mode no longer resolves to strict');
});

test('STRICT STILL FAILS BELOW THE FLOOR — the exact observation that blocked arm A', () => {
  // One simultaneous sample, which is what Unraid measured for arm A. Two isolated three-way samples
  // separated by a non-simultaneous tick: totals of 2, longest unbroken run of 1.
  const timeline = [allScanning(0), oneScanning(TICK), allScanning(TICK * 2)];
  const analysis = analyse(timeline);
  assert(analysis.longestContinuousSimultaneousSamples < CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES,
    `the fixture no longer sits below the floor (${analysis.longestContinuousSimultaneousSamples})`);

  const strict = overlapProblems(analysis);
  assert(strict.some((problem) => /longest UNBROKEN run/.test(problem)),
    `strict mode no longer fails on the continuous-sample floor: ${JSON.stringify(strict)}`);
  // And explicitly passing 'strict' is the same thing.
  assert(overlapProblems(analysis, 'strict').length === strict.length,
    'an explicit strict mode differs from the default');
});

test('STRICT STILL FAILS ON THE DURATION FLOOR, so relaxing only the count would not have been a relaxation', () => {
  // Two adjacent simultaneous samples: the count is 2 and the credited run is one tick — both under their
  // floors. This is why measurement mode relaxes the pair together rather than the count alone.
  const analysis = analyse([allScanning(0), allScanning(TICK)]);
  const strict = overlapProblems(analysis);
  assert(strict.some((problem) => /longest CONTINUOUS three-way overlap credited/.test(problem)),
    `strict mode no longer fails on the duration floor: ${JSON.stringify(strict)}`);
});

// -----------------------------------------------------------------------------------------------------------
// MEASUREMENT MODE RECORDS, AND STILL FAILS CLOSED.
// -----------------------------------------------------------------------------------------------------------

test('MEASUREMENT MODE ACCEPTS THE OBSERVATION ARM A ACTUALLY PRODUCED, and claims nothing by doing so', () => {
  const analysis = analyse([allScanning(0), oneScanning(TICK), allScanning(TICK * 2)]);
  assert(overlapProblems(analysis, 'measurement').length === 0,
    `measurement mode still refuses the observation it exists to record: ${
      JSON.stringify(overlapProblems(analysis, 'measurement'))}`);
  // The figure survives to be reported rather than being replaced by a verdict.
  assert(analysis.longestContinuousSimultaneousSamples === 1,
    `the recorded figure is ${analysis.longestContinuousSimultaneousSamples}, not the observed 1`);
  // And the nonclaim says, in the text that travels with the figure, that it is not an acceptance result.
  assert(/CLOSES NO GATE/.test(OVERLAP_MEASUREMENT_NONCLAIM), 'the nonclaim no longer says it closes no gate');
  assert(/held against no floor/i.test(OVERLAP_MEASUREMENT_NONCLAIM),
    'the nonclaim no longer says the figure is held against no floor');
});

test('MEASUREMENT MODE STILL REQUIRES THE SCAN TO HAVE RUN AT ALL', () => {
  const empty = analyse([]);
  const problems = overlapProblems(empty, 'measurement');
  assert(problems.some((problem) => /took no samples at all/.test(problem)),
    `an empty timeline passed measurement mode: ${JSON.stringify(problems)}`);
});

test('MEASUREMENT MODE STILL REQUIRES ALL THREE SERVERS TO HAVE BEEN OBSERVED SCANNING', () => {
  // Only one server ever scans: three sequential scans, which is what both modes exist to refuse.
  const analysis = analyse([oneScanning(0), oneScanning(TICK), oneScanning(TICK * 2)]);
  const problems = overlapProblems(analysis, 'measurement');
  assert(problems.some((problem) => /servers were ever observed scanning/.test(problem)),
    `a one-server window passed measurement mode: ${JSON.stringify(problems)}`);
  assert(problems.some((problem) => /three-way attribution/.test(problem)),
    'measurement mode does not require full three-way attribution at least once');
});

test('MEASUREMENT MODE STILL FAILS AN UNATTRIBUTED OR ZERO-SUBJECT OBSERVATION', () => {
  // Every server readable and idle: samples were taken, nothing was ever in flight. There is no subject.
  const idle: OverlapSample[] = [0, TICK, TICK * 2].map((atMs) => ({
    atMs, spanMs: 20,
    inFlight: Object.fromEntries(THREE_SERVER_IDS.map((id) => [id, false])),
    unreadable: [],
  }));
  const problems = overlapProblems(analyse(idle), 'measurement');
  assert(problems.length > 0, 'a window in which nothing ever scanned passed measurement mode');
  assert(problems.some((problem) => /three-way attribution|observed scanning/.test(problem)),
    `the refusal does not name the missing subject: ${JSON.stringify(problems)}`);
});

test('MEASUREMENT MODE STILL FAILS WHEN NO TELEMETRY WAS READABLE — a refused or timed-out observer', () => {
  const problems = overlapProblems(analyse([unreadable(0), unreadable(TICK)]), 'measurement');
  assert(problems.length > 0, 'an entirely unreadable window passed measurement mode');
  assert(problems.some((problem) => /readable telemetry|observed scanning|three-way attribution/.test(problem)),
    `the refusal does not name the unreadable telemetry: ${JSON.stringify(problems)}`);
});

test('MEASUREMENT MODE STILL FAILS A MALFORMED OR ABSENT FIGURE, rather than treating it as a small one', () => {
  // The closure check is exercised directly, because a corrupted analysis is exactly what a caller cannot
  // produce through the happy path — and is exactly what must not read as "overlap of zero, recorded".
  const base = analyse([allScanning(0), oneScanning(TICK), allScanning(TICK * 2)]);
  for (const [label, broken] of [
    ['zero', { ...base, longestContinuousSimultaneousSamples: 0 }],
    ['negative', { ...base, longestContinuousSimultaneousSamples: -1 }],
    ['fractional', { ...base, longestContinuousSimultaneousSamples: 1.5 }],
    ['NaN', { ...base, longestContinuousSimultaneousSamples: Number.NaN }],
    ['absent', { ...base, longestContinuousSimultaneousSamples: undefined as unknown as number }],
    ['NaN seconds', { ...base, longestContinuousSimultaneousSeconds: Number.NaN }],
    ['negative seconds', { ...base, longestContinuousSimultaneousSeconds: -1 }],
  ] as const) {
    const problems = measurementClosureProblems(broken);
    assert(problems.length > 0, `a ${label} continuous-overlap figure passed the measurement closure check`);
  }
  // ...and the well-formed one it was derived from does not.
  assert(measurementClosureProblems(base).length === 0,
    `the closure check refuses a valid observation: ${JSON.stringify(measurementClosureProblems(base))}`);
});

// -----------------------------------------------------------------------------------------------------------
// IT CANNOT SPREAD.
// -----------------------------------------------------------------------------------------------------------

test('AN UNRECOGNISED MODE IS REFUSED, never defaulted in either direction', () => {
  for (const bad of ['measure', 'Measurement', 'MEASUREMENT', 'relaxed', 'off', 'true', '1']) {
    let threw = false;
    try { parseOverlapMode(bad); } catch { threw = true; }
    assert(threw, `parseOverlapMode('${bad}') did not throw — a typo would silently pick a mode`);
  }
});

test('ONLY THE MULTI-FRONTEND HARNESS PASSES --overlap-mode, and the Phase 1 gates pass none', () => {
  // This is the containment property, checked over every shipped script rather than the two we happen to
  // remember. A Phase 1 gate that acquired the flag would be a Phase 1 gate with a relaxed floor.
  const harness = 'deploy/projection-multi-frontend-comparison-gate.sh';
  const gates = ['deploy/projection-three-server-concurrency-gate.sh',
    'deploy/projection-rclone-comparison-gate.sh',
    'deploy/projection-emby-dataplane-gate.sh',
    'deploy/projection-jellyfin-dataplane-gate.sh',
    'deploy/projection-plex-dataplane-gate.sh',
    'deploy/projection-path-lifecycle-gate.sh'];
  for (const gate of gates) {
    assert(!/--overlap-mode/.test(read(gate)),
      `${gate} passes --overlap-mode; a Phase 1 gate must keep the strict interpretation`);
  }
  const text = read(harness);
  const opts = (text.match(/--overlap-mode measurement/g) ?? []).length;
  assert(opts === 2, `the harness opts in ${opts} time(s); expected exactly 2 (arm A, and arms B/C)`);
  // Every verify-overlap call in the harness opts in — a half-converted harness would abort on the arm that
  // did not, which is the failure this whole change exists to remove.
  for (const line of text.split('\n')) {
    if (!/verify-overlap/.test(line) || line.trimStart().startsWith('#')) continue;
    assert(/--overlap-mode measurement/.test(line),
      `a harness verify-overlap call does not opt in: ${line.trim()}`);
  }
});

test('THE RELAXED FIGURES ARE RECORDED UNDER A DIFFERENT GATE NAME, so a results file cannot confuse them', () => {
  for (const cli of ['src/ops/projection-three-server-concurrency-cli.ts',
    'src/ops/projection-rclone-comparison-cli.ts']) {
    const text = read(cli);
    assert(/continuous-simultaneous-samples:measured/.test(text),
      `${cli} does not record the relaxed figure under a :measured gate id`);
    assert(/OVERLAP_MEASUREMENT_NONCLAIM/.test(text),
      `${cli} does not attach the nonclaim to the recorded figure`);
    // The strict assertions must still exist for the default path.
    assert(/atLeast\('(TS|RC)1-continuous-simultaneous-samples'/.test(text),
      `${cli} lost the strict continuous-sample assertion entirely`);
    assert(/atLeast\('(TS|RC)1-continuous-simultaneous-seconds'/.test(text),
      `${cli} lost the strict continuous-seconds assertion entirely`);
    // The relaxed figures go through the note-only helper, so they cannot carry a budget.
    assert(/figure3?\('(TS|RC)1-continuous-simultaneous-samples:measured'/.test(text),
      `${cli}'s recorded figure does not use the note-only helper, so it could acquire a threshold`);
  }
});

test('THE STRICT FLOORS THEMSELVES ARE UNCHANGED, so no historical result is reinterpreted', () => {
  // The relaxation is in the INTERPRETATION, never in the numbers. If a floor moved, every past run record
  // that cited it would silently mean something different.
  assert(CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES === 3,
    `MIN_SIMULTANEOUS_SAMPLES is ${CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES}, not the 3 every Phase 1 run `
    + 'record was taken against');
  assert(CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS === 2,
    `MIN_SIMULTANEOUS_SPAN_SECONDS is ${CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS}, not 2`);
  assert(REQUIRED_SERVER_COUNT === 3, `REQUIRED_SERVER_COUNT is ${REQUIRED_SERVER_COUNT}, not 3`);
});

console.log(`\nProjection — overlap measurement mode: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`  FAILED: ${name}: ${String(error)}`);
  process.exit(1);
}
