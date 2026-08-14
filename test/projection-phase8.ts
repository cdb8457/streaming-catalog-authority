import { readFileSync } from 'node:fs';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHASE8_STEPS,
  PHASE8_STEP_TITLES,
  PHASE8_RULES,
  PHASE8_SERVER_IDS,
  PHASE8_NONCLAIMS,
  PHASE8_INHERITED_BETWEEN_CYCLES,
  PHASE8_STEP_DETAIL_GATE_IDS,
  THE_SOAK_IS_FRESH_AND_THE_CYCLES_ARE_NOT,
  phase8BudgetKeyFor,
  requiredCycleGateIds,
  requiredSoakGateIds,
  phase8ClosureProblems,
  type Phase8Results,
} from '../src/core/projection/phase8.js';
import { PHASE7_RULES, PHASE7_SERVER_IDS } from '../src/core/projection/phase7.js';
import { MEDIA_SERVER_SOAK } from '../src/core/projection/media-server-dataplane.js';
import { RELIABILITY_LOOP_RULES } from '../src/core/projection/reliability-loop.js';
import { PROJECTION_PHASE_1_BUDGETS } from '../src/core/projection/runtime-contract.js';

// Projection Phase 8 — the operator soak, offline.
//
// WHAT THIS SUITE IS FOR. The gate needs Docker, /dev/fuse, three real media servers, a real PostgreSQL and
// the operator's real-provider corpus, and one soak is three cycles. This runs everywhere in seconds and pins
// the things a real soak cannot check about itself:
//
//   * that every threshold is IMPORTED from the closed tranche it claims to come from, so a number cannot be
//     re-derived here and drift from the one the product is actually built on;
//   * that the three NEW ones are the three the contract names, at the values it names;
//   * that the freshness INVERSION is encoded rather than described — the soak fresh, the cycles not;
//   * that a short soak, a duplicated verdict, a skip, or a budget the soak supplied for itself cannot be
//     read as success;
//   * and that the gate records every id the module requires.

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

const CONTRACT = 'docs/PROJECTION_PHASE_8_OPERATOR_SOAK.md';

console.log('Projection Phase 8 — the operator soak, offline');

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe cycle, the steps and the order');
// ---------------------------------------------------------------------------------------------------------

test('the cycle is ten steps and the ORDER is part of the contract', () => {
  assertEq(PHASE8_STEPS.length, 10, 'ten steps');
  assertEq(PHASE8_STEPS.join(' '), 'S1 S2 S3 S4 S5 S6 S7 S8 S9 S10', 'the step order');
});

test('every step has a title and a detail set, and no step is silently untitled', () => {
  for (const step of PHASE8_STEPS) {
    assert(typeof PHASE8_STEP_TITLES[step] === 'string' && PHASE8_STEP_TITLES[step].length > 20,
      `${step} has no title`);
    assert(PHASE8_STEP_DETAIL_GATE_IDS[step].length >= 1, `${step} carries no measurement at all`);
  }
});

test('the server ids are Phase 7s own, so no two reports can disagree about who was measured', () => {
  assertEq(PHASE8_SERVER_IDS.join(' '), PHASE7_SERVER_IDS.join(' '), 'the server ids');
  assertEq(PHASE8_SERVER_IDS.join(' '), 'emby jellyfin plex', 'the ids themselves');
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nevery threshold is IMPORTED, and the three new ones say they are new');
// ---------------------------------------------------------------------------------------------------------

test('every budget a closed tranche already derived is IMPORTED rather than derived a second time', () => {
  // TWO DERIVATIONS OF ONE BUDGET ARE TWO BUDGETS THE MOMENT EITHER IS EDITED. These are identities against
  // the module that owns each number, not repetitions of its arithmetic.
  assertEq(PHASE8_RULES.CONSECUTIVE_FRESH_SOAKS, RELIABILITY_LOOP_RULES.CONSECUTIVE_FRESH_RUNS, 'soaks');
  assertEq(PHASE8_RULES.OPERATOR_WINDOWS_REQUIRED, RELIABILITY_LOOP_RULES.OPERATOR_WINDOWS_REQUIRED, 'windows');
  assertEq(PHASE8_RULES.READY_BUDGET_MS, RELIABILITY_LOOP_RULES.READY_BUDGET_MS, 'ready');
  assertEq(PHASE8_RULES.PLAY_DECODED_SECONDS_MIN, MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS, 'direct play');
  assertEq(PHASE8_RULES.TRANSCODE_DECODED_SECONDS_MIN, MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS, 'transcode');
  assertEq(PHASE8_RULES.PLAY_START_BUDGET_MS, MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS * 1_000, 'startup');
  assertEq(PHASE8_RULES.SEEK_COUNT, MEDIA_SERVER_SOAK.SEEK_COUNT, 'seeks');
  assertEq(PHASE8_RULES.LIBRARY_CHURN_MAX, PROJECTION_PHASE_1_BUDGETS.MAX_LIBRARY_CHURN_ITEMS, 'churn');
  assertEq(PHASE8_RULES.RECOVERY_ACTION_BUDGET_MS, PHASE7_RULES.RECOVERY_ACTION_BUDGET_MS, 'action budget');
  assertEq(PHASE8_RULES.RECOVERY_READY_BUDGET_MS, PHASE7_RULES.RECOVERY_READY_BUDGET_MS, 'ready budget');
  assertEq(PHASE8_RULES.SINGLE_FLIGHT_ACTIONS_MAX, PHASE7_RULES.SINGLE_FLIGHT_ACTIONS_MAX, 'single flight');
  assertEq(PHASE8_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX, PHASE7_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX, 'layers');
  assertEq(PHASE8_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END,
    PHASE7_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END, 'layers at end');
});

test('the mount-layer threshold is the SAME NUMBER Phase 7 closed on, and it is 1', () => {
  // IT IS ASSERTED ABSOLUTELY AS WELL AS BY IDENTITY, deliberately. An identity against a module that had
  // itself been widened would agree with a widening; the literal is what refuses that.
  assertEq(PHASE8_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX, 1, 'the layer threshold');
  assertEq(PHASE8_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END, 1, 'the end-of-soak layer threshold');
});

test('the three NEW thresholds are the three the contract names, at the values it names', () => {
  assertEq(PHASE8_RULES.CYCLES_PER_SOAK, 3, 'cycles per soak');
  assertEq(PHASE8_RULES.CONSUMER_RESTARTS_MAX, 0, 'consumer restarts');
  assertEq(PHASE8_RULES.OPERATOR_INTERVENTIONS_MAX, 0, 'operator interventions');
});

test('the freshness INVERSION is encoded rather than described', () => {
  assertEq(THE_SOAK_IS_FRESH_AND_THE_CYCLES_ARE_NOT, true,
    'the soak is no longer fresh-with-inherited-cycles, which is the whole tranche');
  assert(PHASE8_INHERITED_BETWEEN_CYCLES.length >= 6,
    'the inherited list is too short to be the honest one');
  const joined = PHASE8_INHERITED_BETWEEN_CYCLES.join(' ').toLowerCase();
  for (const needle of ['cache', 'ledger', 'manifest', 'configuration', 'container', 'mount point']) {
    assert(joined.includes(needle), `the inherited list does not name the ${needle}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe closure check cannot be talked into a pass');
// ---------------------------------------------------------------------------------------------------------

const passing = (): Phase8Results => {
  const results: Array<{ gate: string; verdict: 'pass'; measured?: number; budget?: number }> = [];
  const add = (gate: string): void => {
    const key = phase8BudgetKeyFor(gate);
    if (key === undefined) { results.push({ gate, verdict: 'pass' }); return; }
    const budget = PHASE8_RULES[key] as number;
    results.push({ gate, verdict: 'pass', measured: budget, budget });
  };
  for (let cycle = 1; cycle <= PHASE8_RULES.CYCLES_PER_SOAK; cycle += 1) {
    for (const id of requiredCycleGateIds(cycle)) add(id);
  }
  for (const id of requiredSoakGateIds()) add(id);
  return {
    cycles: [{ index: 1, cycle: 1 }, { index: 2, cycle: 2 }, { index: 3, cycle: 3 }],
    results: results as Phase8Results['results'],
  };
};

test('a complete soak with every required id passing has no problems', () => {
  const problems = phase8ClosureProblems(passing());
  assertEq(problems.length, 0, `a complete soak reported problems: ${problems.join(' | ')}`);
});

test('a soak that ran two cycles is not a soak that passed', () => {
  const document = passing();
  const short: Phase8Results = { cycles: document.cycles.slice(0, 2), results: document.results };
  const problems = phase8ClosureProblems(short);
  assert(problems.some((p) => p.includes('2 cycle(s) against the predeclared 3')),
    `a two-cycle soak was not refused: ${problems.join(' | ')}`);
});

test('an absent measurement is not a passing one', () => {
  const document = passing();
  const missing: Phase8Results = {
    cycles: document.cycles,
    results: document.results.filter((r) => r.gate !== 'P8-cycle-layers:C2'),
  };
  const problems = phase8ClosureProblems(missing);
  assert(problems.some((p) => p.startsWith('P8-cycle-layers:C2 is absent')),
    `a missing per-cycle layer count was not refused: ${problems.join(' | ')}`);
});

test('two verdicts under one id are refused rather than the later one winning', () => {
  const document = passing();
  const doubled: Phase8Results = {
    cycles: document.cycles,
    results: [...document.results, document.results[0]!],
  };
  assert(phase8ClosureProblems(doubled).some((p) => p.includes('carries two verdicts')),
    'a duplicated verdict was not refused');
});

test('a skip is a failure, and so is a failure outside the required set', () => {
  const document = passing();
  const skipped: Phase8Results = {
    cycles: document.cycles,
    results: [...document.results, { gate: 'P8-extra', verdict: 'skip' } as never],
  };
  assert(phase8ClosureProblems(skipped).some((p) => p.includes('P8-extra is skip')), 'a skip was not refused');
  const failedExtra: Phase8Results = {
    cycles: document.cycles,
    results: [...document.results, { gate: 'P8-other', verdict: 'fail' } as never],
  };
  assert(phase8ClosureProblems(failedExtra).some((p) => p.includes('P8-other is fail')),
    'a failure outside the required set was not refused');
});

test('a budget the SOAK supplied for itself is refused, even beside a correct measurement', () => {
  const document = passing();
  const tampered: Phase8Results = {
    cycles: document.cycles,
    results: document.results.map((r) => (r.gate === 'P8-cycle-layers:C1'
      ? { ...r, measured: 2, budget: 2 } : r)) as Phase8Results['results'],
  };
  const problems = phase8ClosureProblems(tampered);
  assert(problems.some((p) => p.includes('P8-cycle-layers:C1 was measured against 2 where the contract names 1')),
    `a soak-supplied budget was accepted: ${problems.join(' | ')}`);
});

test('the consumer-restart and operator-intervention counts are BUDGETED ids, not free-text', () => {
  assertEq(phase8BudgetKeyFor('P8-consumers-never-touched'), 'CONSUMER_RESTARTS_MAX', 'consumer restarts');
  assertEq(phase8BudgetKeyFor('P8-S10-no-operator-intervention:C3'), 'OPERATOR_INTERVENTIONS_MAX',
    'operator interventions');
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe contract document says what the module says');
// ---------------------------------------------------------------------------------------------------------

test('the contract exists, predeclares a NO-GO list, and does not yet claim a GO', () => {
  const document = read(CONTRACT);
  assert(document.includes('What makes this tranche a NO-GO'), 'the NO-GO conditions are not predeclared');
  assert(/Status: OPEN|Status: NO-GO|Status: GO/.test(document), 'the document carries no status');
  for (const step of PHASE8_STEPS) {
    assert(document.includes(`**${step} —`), `the contract does not name step ${step}`);
  }
});

test('the contract predeclares the freshness inversion in terms, because it is the whole tranche', () => {
  const document = read(CONTRACT);
  assert(/THE SOAK IS FRESH AND THE CYCLES ARE NOT/.test(document),
    'the contract no longer states the inversion');
  assert(document.includes('a cycle that finds any of them new **fails**'),
    'the contract no longer says a cycle that finds its inheritance new FAILS');
});

test('the contract predeclares the two thresholds this tranche adds, and says they are counted per SOAK', () => {
  const document = read(CONTRACT);
  assert(document.includes('CONSUMER_RESTARTS_MAX'), 'the consumer-restart threshold is not predeclared');
  assert(document.includes('OPERATOR_INTERVENTIONS_MAX'), 'the intervention threshold is not predeclared');
  assert(/Counted across the whole soak, not per cycle/i.test(document),
    'the contract no longer says the consumer-restart count is across the whole soak');
});

test('the contract refuses to relabel Phase 7 evidence or to claim endurance', () => {
  const document = read(CONTRACT);
  assert(/does not relabel Phase 7/i.test(document), 'the contract no longer refuses to relabel Phase 7');
  assert(/not an uptime, availability or endurance claim/i.test(document),
    'the contract no longer refuses the endurance claim');
  assert(PHASE8_NONCLAIMS.length >= 8, 'the nonclaim list is too short to be the honest one');
  const joined = PHASE8_NONCLAIMS.join(' ').toLowerCase();
  for (const needle of ['endurance', 'load test', 'attribution', 'relabel']) {
    assert(joined.includes(needle), `the nonclaim list does not refuse ${needle}`);
  }
});

test('the contract imports Phase 7s provider rule rather than restating it', () => {
  const document = read(CONTRACT);
  assert(/PHASE 7 §7 APPLIES UNCHANGED/.test(document),
    'the contract no longer imports Phase 7s provider-origin rule');
  assert(/BLOCKED, not failed/.test(document), 'the contract no longer carries the BLOCKED-not-failed rule');
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe gate records what the module requires, and restates none of its numbers');
// ---------------------------------------------------------------------------------------------------------

const GATE = 'deploy/projection-phase8-gate.sh';
const gate = read(GATE);

test('every id the module REQUIRES is an id the gate actually records', () => {
  // A CONTRACT THAT REQUIRES AN ID NO GATE EMITS IS A CONTRACT THAT CAN NEVER BE SATISFIED, and a gate that
  // emits an id the contract does not require is one whose failure nobody has to explain. This is the first
  // half; the closure check is the second.
  const missing: string[] = [];
  for (const id of [...requiredCycleGateIds(1), ...requiredSoakGateIds()]) {
    const bare = id.replace(/:(emby|jellyfin|plex):C1$/, '').replace(/:C1$/, '');
    if (!gate.includes(bare)) missing.push(id);
  }
  assert(missing.length === 0, `the gate records none of: ${missing.join(', ')}`);
});

test('the gate RESTATES no threshold and evaluates them out of the module once', () => {
  // THE BUDGETS LEAVE THE MODULE AS SHELL ASSIGNMENTS AND THE GATE EVALS THEM, which is what stops a number
  // drifting between the document, the module and the shell. A literal spelling anywhere in the gate is a
  // second copy of a number the contract derives.
  assert(/P8_BUDGETS="\$\(npx tsx src\/ops\/projection-phase8-cli\.ts budgets --sh\)"/.test(gate),
    'the gate no longer reads its budgets out of the contract module');
  assert(gate.includes('eval "$P8_BUDGETS"'), 'the gate no longer evaluates the budgets it read');
  const executable = gate.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  for (const value of [
    PHASE8_RULES.PLAY_DECODED_SECONDS_MIN,
    PHASE8_RULES.RECOVERY_ACTION_BUDGET_MS,
    PHASE8_RULES.RECOVERY_READY_BUDGET_MS,
    PHASE8_RULES.READY_BUDGET_MS,
  ]) {
    assert(!new RegExp(`[=:-]\\s*${value}\\b`).test(executable),
      `the gate spells ${value} literally instead of reading it from the module`);
  }
});

test('the gate takes its own loopback ports, so it can never collide with another gate', () => {
  // TWO GATES ON ONE HOST BINDING ONE PORT IS A SECOND RUN DYING ON "port is already allocated", which reads
  // like a gate defect and is not. Every port this gate takes is asserted different from Phase 7's.
  const phase7 = read('deploy/projection-phase7-gate.sh');
  const portsOf = (source: string): string[] =>
    [...source.matchAll(/:-(\d{4,5})\}/g)].map((match) => match[1] as string);
  const mine = new Set(portsOf(gate));
  const theirs = new Set(portsOf(phase7));
  const shared = [...mine].filter((port) => theirs.has(port));
  assert(shared.length === 0, `the Phase 8 gate shares loopback port(s) with Phase 7: ${shared.join(', ')}`);
  assert(mine.size >= 4, 'the gate declares too few ports to be the one that binds a database and three servers');
});

test('the three-runner and the optional wrapper exist and are reachable through npm', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assertEq(scripts['go:phase8-gate'], 'bash deploy/projection-phase8-gate.sh', 'the single gate');
  assertEq(scripts['go:phase8-gate:three'], 'bash deploy/projection-phase8-gate-three.sh', 'the three-runner');
  assertEq(scripts['go:phase8-gate:optional'], 'bash deploy/projection-phase8-gate-optional.sh', 'the optional');
  const three = read('deploy/projection-phase8-gate-three.sh');
  // A SKIP IS NOT A COMPLETED SOAK AND THE WRAPPER'S OWN ACCOUNTING IS WHAT SAYS SO.
  assert(three.includes('completed=0'), 'the three-runner no longer counts completed soaks');
  assert(/SKIPPED at run/.test(three), 'the three-runner no longer refuses to fold a skip into success');
  assert(/projection-phase8-gate.sh/.test(three), 'the three-runner does not run the Phase 8 gate');
  assert(three.includes('bash "$GATE_COMMAND"'), 'the three-runner no longer invokes the gate it resolved');
});

test('the gate asserts the INHERITANCE, which is the one thing that makes it a soak', () => {
  assert(gate.includes('P8-cycle-inherited'), 'the gate no longer asserts what a cycle inherited');
  assert(gate.includes('inherit_fingerprint'), 'the inheritance is no longer fingerprinted');
  // BY IDENTITY AND NOT BY EXISTENCE. A recreated cache directory exists; it is not the one the last cycle
  // used, and an existence check would pass over exactly the thing this tranche is measuring.
  assert(/stat -c 'cache %i'/.test(gate), 'the cache is no longer compared by inode');
  assert(/\{\{\.Id\}\} \{\{\.State\.StartedAt\}\}/.test(gate),
    'the servers are no longer compared by container id AND start instant');
  assert(gate.includes('OPERATOR INTERVENTION #'),
    'the gate no longer counts the things a human had to do between cycles');
});

test('the gate injects no SIGKILL, reboots nothing and never writes the operator endpoint file', () => {
  // §8.2 OF THE CONTRACT IS A DECISION AND THIS IS WHAT KEEPS IT. An operator soak measures the ordinary
  // path; a SIGKILL is not one, and injecting it would measure a limitation the product already declares.
  const executable = gate.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert(!/kill -s 9|kill -9|--signal *KILL/.test(executable), 'the gate injects a SIGKILL');
  assert(!/reboot|shutdown -r/.test(executable), 'the gate reboots something');
  assert(!/> *[^ ]*endpoint\.json|tee [^ ]*endpoint\.json/.test(executable),
    'the gate writes the operator endpoint file');
});

test('this suite is wired into the offline inventory, so a rename cannot silently end the coverage', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase8.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as {
    suites: Array<{ file: string; group: string }>;
  };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase8.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'the suite runs in the offline group');
});

// ---------------------------------------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  for (const [name, error] of failures) {
    console.error(`\n  ${name}\n    ${(error as Error).message}`);
  }
  process.exit(1);
}
