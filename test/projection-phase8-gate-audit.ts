import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  PHASE8_GATE_HELPERS,
  collectEmissions,
  expandEmission,
  helperProblems,
  joinContinuations,
  phase8GateWiringProblems,
  readCycleLoop,
  readFunctions,
  tokenizeArguments,
} from '../src/core/projection/phase8-gate-audit.js';
import { publishedShellNames } from '../src/ops/projection-phase8-gate-audit-cli.js';
import { PHASE8_RULES, requiredCycleGateIds } from '../src/core/projection/phase8.js';

// Projection Phase 8 — the gate's WIRING, offline.
//
// WHAT THIS SUITE IS FOR, AND IT IS NOT THE SAME QUESTION `test/projection-phase8.ts` ASKS. That suite pins
// the CONTRACT: that every threshold is imported, that the freshness inversion is encoded, that a short soak
// cannot be read as success. This one pins the INSTRUMENT — that the 3,419-line gate would, if run, actually
// write the verdicts the closure rule demands, under the names it demands them, carrying measurements where
// the contract names a budget, and reading no shell name that nothing gives it.
//
// WHY IT IS A SEPARATE SUITE AND NOT FOUR MORE TESTS IN THAT ONE. The pin it replaces lived there and did not
// bite: "every id the module REQUIRES is an id the gate actually records" stripped the `:C1` and `:<server>`
// suffixes off each required id and asked whether the bare string appeared anywhere in the file. It passed
// against a gate that recorded five of S5's ids with no cycle suffix at all — so each of them was written
// three times under one name, none of the fifteen ids the closure rule actually requires was ever written,
// and the suite was green. A check that asserts the shape without asserting the thing the shape exists to
// prevent is the failure mode this repository keeps meeting, and the fix is not a stricter grep: it is a
// model of the gate that produces the ids a soak would write and compares THOSE.
//
// EVERY TAMPER BELOW IS A CONTROL AND EVERY CONTROL FAILS FOR ITS OWN REASON. A pin that cannot be shown to
// bite is a pin nobody has tested, so each of the four defect classes this audit exists to catch is injected
// into a COPY of the gate held in memory — no file is written — and the audit is required to name it.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push([name, error]);
    console.log(`  FAIL  ${name}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: got ${String(actual)}, want ${String(expected)}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const GATE_PATH = 'deploy/projection-phase8-gate.sh';
const gate = read(GATE_PATH);
const names = publishedShellNames();

/** Every problem the audit reports about a variant of the gate. */
const problemsFor = (source: string): readonly string[] =>
  phase8GateWiringProblems(source, names).problems;

/** A tamper must produce a problem that MENTIONS the thing it broke, not merely some problem. */
function assertCaught(source: string, needle: string, what: string): void {
  const problems = problemsFor(source);
  assert(problems.length > 0, `${what}: the audit reported nothing at all`);
  assert(problems.some((problem) => problem.includes(needle)),
    `${what}: the audit reported ${problems.length} problem(s) but none named ${needle}: `
    + problems.slice(0, 3).join(' | '));
}

console.log('Projection Phase 8 — the gate\'s wiring, offline');

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe model can still read the gate it is a model of');
// ---------------------------------------------------------------------------------------------------------

test('the gate parses into functions, and the ones this audit models are among them', () => {
  const functions = readFunctions(gate);
  assert(functions.size > 40, `only ${functions.size} function(s) were found in the gate`);
  for (const helper of Object.keys(PHASE8_GATE_HELPERS)) {
    assert(functions.has(helper), `the gate no longer defines ${helper}(), which this audit models by name`);
  }
});

test('the cycle loop is found, and it is what makes a measurement per-cycle rather than once', () => {
  const loop = readCycleLoop(gate);
  assert(loop.found, 'the `for CYCLE_INDEX in ...` loop could not be located');
  assert(loop.lines.length > 10, 'the cycle loop body is implausibly short');
  const body = loop.lines.map((entry) => entry.text).join('\n');
  for (const step of ['step_S1_preflight', 'step_S5_recovery_cycle', 'step_S10_cleanup_accounting',
    'assert_inherited', 'verify_after_cycle']) {
    assert(body.includes(step), `the cycle loop no longer calls ${step}`);
  }
});

test('the helper model still matches the helpers, so its verdict is about the real gate', () => {
  assertEq(helperProblems(gate).join(' | '), '', 'the helper model has drifted from the gate');
});

test('a continuation is one logical line, because a call whose arguments span two is one call', () => {
  const joined = joinContinuations([
    { text: 'phase_bytes "a" "b" "c" \\', line: 10 },
    { text: '  "d" "e" "f"', line: 11 },
    { text: 'record "x" bool 1', line: 12 },
  ]);
  assertEq(joined.length, 2, 'two logical lines');
  assertEq(joined[0]?.line, 10, 'the joined line keeps the FIRST physical line number');
  assertEq(tokenizeArguments((joined[0]?.text ?? '').replace(/^phase_bytes\s+/, '')).join(','),
    'a,b,c,d,e,f', 'all six arguments survive the join');
});

test('the tokenizer reads the gate\'s own argument shapes and stops where a call stops', () => {
  assertEq(tokenizeArguments('"P8-S6-layers:$CYCLE_ID" le "$layers" "$MAX" \\').join(','),
    'P8-S6-layers:$CYCLE_ID,le,$layers,$MAX,\\', 'quoted arguments');
  assertEq(tokenizeArguments('"P8-x" bool 1 "" "note" || true').join(','),
    'P8-x,bool,1,,note', 'a `|| true` ends the call');
  assertEq(tokenizeArguments('"P8-y" - - "prefix" ":$CYCLE_ID" "what"').join(','),
    'P8-y,-,-,prefix,:$CYCLE_ID,what', 'the suppression token survives as itself');
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe gate as it stands would write the verdicts the closure rule requires');
// ---------------------------------------------------------------------------------------------------------

test('the shipped Phase 8 gate has no wiring problem at all', () => {
  const problems = problemsFor(gate);
  assertEq(problems.join('\n    '), '', `${problems.length} wiring problem(s)`);
});

test('every id the closure rule requires is recorded EXACTLY once per soak, suffix and all', () => {
  // THE SUFFIX IS THE POINT. This is the assertion the old pin could not make, because it removed the suffix
  // before looking for the id.
  const counts = new Map<string, number>();
  for (const emission of collectEmissions(gate)) {
    for (const id of expandEmission(emission)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (let cycle = 1; cycle <= PHASE8_RULES.CYCLES_PER_SOAK; cycle += 1) {
    for (const id of requiredCycleGateIds(cycle)) {
      assertEq(counts.get(id) ?? 0, 1, `${id} is recorded the wrong number of times`);
    }
  }
});

test('every P8_ name the gate reads is one the contract CLI publishes or the gate itself assigns', () => {
  const unpublished = problemsFor(gate).filter((problem) => problem.includes('under `set -u`'));
  assertEq(unpublished.join(' | '), '', 'an unbound shell name would exit the gate where it stands');
});

test('the published names are derived from the module, so a dropped budget cannot hide here', () => {
  // A LIST KEPT BESIDE THE CLI IS A SECOND COPY OF IT. Every threshold key must appear, prefixed, because
  // that is exactly what `budgets --sh` prints.
  for (const key of Object.keys(PHASE8_RULES)) {
    assert(names.includes(`P8_${key}`), `P8_${key} is not among the names the audit believes are published`);
  }
  const cli = read('src/ops/projection-phase8-cli.ts');
  for (const extra of ['P8_STEPS', 'P8_SERVERS', 'P8_INHERITED', 'P8_POLL_INTERVAL_MS',
    'P8_READ_FAIL_BUDGET_MS']) {
    assert(names.includes(extra), `${extra} is missing from the audit's list`);
    assert(cli.includes(extra), `${extra} is in the audit's list but the CLI does not print it`);
  }
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe controls — every defect class this audit exists to catch, injected and named');
// ---------------------------------------------------------------------------------------------------------

test('CONTROL: an id recorded without its cycle suffix is BOTH absent and duplicated', () => {
  const tampered = gate.replace('record "P8-S5-action-ms:$CYCLE_ID"', 'record "P8-S5-action-ms"');
  assert(tampered !== gate, 'the tamper did not apply, so this control tested nothing');
  const problems = problemsFor(tampered);
  for (const cycle of ['C1', 'C2', 'C3']) {
    assert(problems.some((problem) => problem.includes(`requires P8-S5-action-ms:${cycle}`)),
      `the audit did not report P8-S5-action-ms:${cycle} as absent`);
  }
  assert(problems.some((problem) => problem.includes('records P8-S5-action-ms 3 times')),
    'the audit did not report the unsuffixed id as carrying three verdicts');
});

test('CONTROL: a shell name nothing publishes is named with the line that reads it', () => {
  const tampered = gate.replace('P8_RECOVERY_ACTION_BUDGET_MS + 1000',
    'P8_NOT_PUBLISHED_ANYWHERE + 1000');
  assert(tampered !== gate, 'the tamper did not apply, so this control tested nothing');
  assertCaught(tampered, 'P8_NOT_PUBLISHED_ANYWHERE', 'an unpublished shell name');
});

test('CONTROL: a budgeted id recorded as a boolean carries no measurement, and is refused', () => {
  const tampered = gate.replace(
    'record "P8-S6-layers:$CYCLE_ID" le "$layers" "$P8_MOUNT_LAYERS_ABOVE_FLOOR_MAX"',
    'record "P8-S6-layers:$CYCLE_ID" bool 1 ""');
  assert(tampered !== gate, 'the tamper did not apply, so this control tested nothing');
  assertCaught(tampered, "records it with 'bool'", 'a budgeted id recorded as a boolean');
});

test('CONTROL: a helper that grows a record fails the model rather than being mis-read', () => {
  const tampered = gate.replace('    record "$id" bool 1 "" "$label"',
    '    record "$id" bool 1 "" "$label"\n    record "$id-extra" bool 1 "" "$label"');
  assert(tampered !== gate, 'the tamper did not apply, so this control tested nothing');
  assertCaught(tampered, 'leak_scan() makes', 'a helper the model no longer describes');
});

test('CONTROL: a required id deleted outright is reported for all three cycles', () => {
  const tampered = gate.replace(/record "P8-S8-reset-cleared-it:\$CYCLE_ID"/g, 'true "P8-removed"');
  assert(tampered !== gate, 'the tamper did not apply, so this control tested nothing');
  for (const cycle of ['C1', 'C2', 'C3']) {
    assertCaught(tampered, `requires P8-S8-reset-cleared-it:${cycle}`, 'a deleted required id');
  }
});

test('CONTROL: losing the cycle loop is reported rather than silently making everything once-per-soak', () => {
  const tampered = gate.replace(/^for CYCLE_INDEX in .*$/m, 'for CYCLE_RENAMED in 1 2 3; do');
  assert(tampered !== gate, 'the tamper did not apply, so this control tested nothing');
  assertCaught(tampered, 'no `for CYCLE_INDEX in ...` loop', 'a cycle loop this audit cannot find');
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe rehearsal, and this suite\'s own place in the inventory');
// ---------------------------------------------------------------------------------------------------------

test('the provider-free rehearsal exists and is reachable through npm', () => {
  const rehearsal = read('deploy/projection-phase8-rehearsal.sh');
  assert(rehearsal.length > 4000, 'the rehearsal is implausibly short');
  const scripts = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(scripts.scripts['go:phase8-rehearsal'], 'bash deploy/projection-phase8-rehearsal.sh',
    'the rehearsal is not reachable through npm');
  // IT MUST RUN THE AUDIT ABOVE BEFORE IT TOUCHES DOCKER, because a wiring defect that costs seconds on any
  // host must never be discovered by an hour of provider traffic on one.
  assert(rehearsal.includes('projection-phase8-gate-audit-cli.ts'),
    'the rehearsal does not run the static wiring audit');
  // AND IT MUST CONTACT NO PROVIDER. §11.2's whole point is an instrument that needs no metered account.
  assert(!rehearsal.includes('torbox-credential') && !rehearsal.includes('PROJECTION_TORBOX_INPUT_DIR'),
    'the rehearsal reads the operator\'s provider inputs, which is the one thing it exists not to need');
});

test('this suite is wired into the offline inventory, so a rename cannot silently end the coverage', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase8-gate-audit.ts'),
    'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as {
    suites: Array<{ file: string; group: string }>;
  };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase8-gate-audit.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'the suite runs in the offline group');
});

// ---------------------------------------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  for (const [name, error] of failures) console.error(`\nFAIL ${name}\n  ${String(error)}`);
  process.exit(1);
}
