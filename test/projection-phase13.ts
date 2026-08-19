import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { phase9RequiresSoakRerun } from '../src/core/projection/phase9.js';
import { PHASE12_RULES } from '../src/core/projection/phase12.js';
import {
  ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES,
  ORIGIN_RECORD_MAX_AGE_MINUTES,
} from '../src/core/projection/phase13-preentry.js';
import {
  PHASE13_ACCEPTANCE_GATE_IDS,
  PHASE13_CEILING_SENTENCE,
  PHASE13_CLOSURE_GATE_IDS,
  PHASE13_ENTRY_CRITERIA,
  PHASE13_EXIT_CRITERIA,
  PHASE13_FORBIDDEN_EMITTABLE_IDS,
  PHASE13_FORBIDDEN_SOURCE,
  PHASE13_GATE_TITLES,
  PHASE13_MEANING,
  PHASE13_NONCLAIMS,
  PHASE13_OWNERSHIP_SECTION,
  PHASE13_PRESERVED_STATES,
  PHASE13_RULES,
  PHASE13_SEQUENCE_GATE_IDS,
  PHASE13_TRANCHE_PATHS,
  phase13BudgetKeyFor,
  phase13BudgetKeysFor,
  phase13ClosureProblems,
  phase13Closed,
  phase13EntryRefusals,
  phase13ExitRefusals,
  phase13ExitSatisfied,
  phase13MayEnter,
  type Phase13EntryState,
  type Phase13ExitState,
  type Phase13GateResult,
} from '../src/core/projection/phase13.js';

// Projection Phase 13 — the contract's own rules, and the agreement between the prose and the functions.
//
// WHY THIS SUITE EXISTS AT ALL, AND IT IS NOT "BECAUSE EVERY MODULE HAS ONE". Phase 12 found a defect at its
// own §11.4 where the SHIPPED FUNCTION WAS STRICTER THAN THE PROSE IT WAS WRITTEN FROM, and it found it by
// running the function rather than by reading it. A contract whose document and whose code disagree is a
// contract with two versions, and the run will be measured by whichever one somebody happens to open. So the
// document is parsed here and compared to the module, in both directions, for the claim ids, the thresholds,
// the entry criteria, the exit criteria, the preserved states and the non-claims.
//
// IT CONTACTS NOTHING, READS NO OPERATOR INPUT AND STARTS NOTHING. Every function under test is pure.

const h = createHarness('Projection Phase 13 — the real provider acceptance contract');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');
/**
 * Line endings, wrapping and block-quote markers removed, so a sentence the document wraps is still one
 * sentence.
 *
 * THE `>` MARKERS ARE STRIPPED FIRST AND THAT IS NOT COSMETIC. §2.3's meaning is a block quote, so a naive
 * whitespace flatten leaves `the operator's own > account` where the line broke — and the comparison then
 * fails for the wrapping rather than for the words, which is a check about a text editor.
 */
const flat = (relative: string): string =>
  read(relative).replace(/^[ \t]*>[ \t]?/gm, '').replace(/\s+/g, ' ');

const CONTRACT = 'docs/PROJECTION_PHASE_13_REAL_PROVIDER_ACCEPTANCE.md';
const MODULE = 'src/core/projection/phase13.ts';

// ---------------------------------------------------------------------------------------------------------
h.section('§5 — the claims, and the document and the function agreeing about them');
// ---------------------------------------------------------------------------------------------------------

test('the module names eleven claims, eight of them provider-facing, in the document\'s order', () => {
  assertEq(PHASE13_ACCEPTANCE_GATE_IDS.length, 8, 'Tier A is not eight arms');
  assertEq(PHASE13_SEQUENCE_GATE_IDS.length, 3, 'Tier S is not three claims');
  assertEq(PHASE13_CLOSURE_GATE_IDS.length, 11, 'the closure list is not the two tiers');
  assertEq(new Set(PHASE13_CLOSURE_GATE_IDS).size, 11, 'a claim id appears twice');
  // THE ORDER IS THE DOCUMENT'S, so a reader comparing the two reads the same list twice rather than a
  // permutation they have to sort in their head.
  const document = read(CONTRACT);
  let at = -1;
  for (const id of PHASE13_CLOSURE_GATE_IDS) {
    const here = document.indexOf(`\`${id}\``);
    assert(here > at, `${id} is missing from the document, or is out of §5's order`);
    at = here;
  }
});

test('every claim has a title, and no title belongs to a claim §5 does not name', () => {
  for (const id of PHASE13_CLOSURE_GATE_IDS) {
    const title = PHASE13_GATE_TITLES[id];
    assert(typeof title === 'string' && title.length > 40, `${id} has no usable title`);
  }
  assertEq(Object.keys(PHASE13_GATE_TITLES).length, PHASE13_CLOSURE_GATE_IDS.length,
    'the title map and the claim list are different sizes, so one of them names a claim the other does not');
});

test('every threshold §5.3 names is in the module, and every imported one is READ from its own tranche', () => {
  const document = read(CONTRACT);
  for (const key of Object.keys(PHASE13_RULES)) {
    assert(document.includes(`\`${key}\``), `§5.3 does not name ${key}`);
  }
  // AND THE IMPORTS ARE IDENTITIES, not copies that happen to agree today. A restated threshold is a
  // threshold that can drift, silently, in the direction that lets a run start.
  assertEq(PHASE13_RULES.CONSECUTIVE_FRESH_RUNS, PHASE12_RULES.CONSECUTIVE_FRESH_RUNS, 'imported runs');
  assertEq(PHASE13_RULES.SKIPPED_CLAIMS_MAX, PHASE12_RULES.SKIPPED_CLAIMS_MAX, 'imported skips');
  assertEq(PHASE13_RULES.RESIDUE_MAX, PHASE12_RULES.RESIDUE_MAX, 'imported residue');
  assertEq(PHASE13_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX, PHASE12_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX,
    'imported controls');
  assertEq(PHASE13_RULES.ORIGIN_RECORD_MAX_AGE_MINUTES, ORIGIN_RECORD_MAX_AGE_MINUTES, 'imported record age');
  assertEq(PHASE13_RULES.ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES, ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES,
    'imported margin');
});

test('THE ONLY FLOOR IN THE CONTRACT IS THE ONE THAT MAKES CONTACT ASSERTABLE', () => {
  // EVERY OTHER NUMBER IN THIS CONTRACT IS SATISFIED BY A RUN THAT CONTACTED NOTHING. Zero mismatches, zero
  // secret traces, zero admitted writes, zero host losses — a gate whose every assertion is satisfied by
  // silence can report a pass for a run that never dialled anything. This is the assertion that it did.
  assertEq(PHASE13_RULES.RESOLUTIONS_PER_OBJECT_MIN, 1, 'the resolution floor is not one per object');
  const ceilings = Object.entries(PHASE13_RULES)
    .filter(([key]) => key.endsWith('_MAX'))
    .filter(([key]) => key !== 'RESOLUTIONS_PER_OBJECT_MAX'
      && key !== 'ORIGIN_RECORD_MAX_AGE_MINUTES');
  for (const [key, value] of ceilings) {
    assertEq(value, 0, `${key} is not zero, and every ceiling in this contract is`);
  }
});

test('a claim with a budget has one, and a claim without one is not given a place to invent one', () => {
  for (const id of PHASE13_CLOSURE_GATE_IDS) {
    const key = phase13BudgetKeyFor(id);
    if (key === undefined) continue;
    assert(key in PHASE13_RULES, `${id} names a budget ${key} the module does not carry`);
  }
  // THE ONE CLAIM §5 GIVES NO BUDGET, and the one it gives a RANGE rather than a ceiling.
  assertEq(phase13BudgetKeyFor(PHASE13_CLOSURE_GATE_IDS[1]), undefined, 'P13-A2 has nothing to count');
  assertEq(phase13BudgetKeyFor(PHASE13_CLOSURE_GATE_IDS[3]), undefined,
    'P13-A4 is measured against a RANGE and must not be squeezed into the single-ceiling path, which has '
    + 'nowhere to put its floor');
  // AND `P13-S2` DOES HAVE SOMETHING TO COUNT, which is the defect this assertion used to enshrine. §5.2
  // gives it `CONSECUTIVE_FRESH_RUNS` and `SKIPPED_CLAIMS_MAX`, and while the function answered `undefined`
  // a result set that recorded the claim the way §5.2 documents it was ACTIVELY REFUSED as having invented
  // a budget.
  assertEq(phase13BudgetKeyFor(PHASE13_CLOSURE_GATE_IDS[9]), 'SKIPPED_CLAIMS_MAX',
    'P13-S2 carries no ceiling, so §5.2 and the function disagree again');
});

test('EVERY BUDGET §5 NAMES FOR A CLAIM IS THE BUDGET THE FUNCTION MAPS IT TO, claim by claim', () => {
  // WHY THIS IS THE STRUCTURAL TEST THIS SUITE WAS MISSING. §5's header says the suite makes the list and
  // the document agree "so the defect Phase 12 found at its own §11.4 cannot recur here". It had recurred,
  // in the BUDGET COLUMN — the one part of §5 nothing compared. The old checks asserted that every threshold
  // NAME appears somewhere in the document and that a returned key exists in `PHASE13_RULES`; neither can
  // see a claim whose column names two thresholds and whose mapping names one, or none.
  const document = read(CONTRACT);
  const lines = document.split(/\r?\n/);
  for (const id of PHASE13_CLOSURE_GATE_IDS) {
    const row = lines.find((line) => line.startsWith(`| \`${id}\``));
    assert(row !== undefined, `§5 has no table row for ${id}`);
    const cells = row!.split('|').map((cell) => cell.trim());
    // The Budget column is the LAST cell of the row, after the trailing empty one the pipe leaves.
    const documented = [...cells[cells.length - 2]!.matchAll(/`([A-Z0-9_]+)`/g)].map((one) => one[1]!);
    const mapped = phase13BudgetKeysFor(id);
    assertEq(mapped.join(', '), documented.join(', '),
      `§5's Budget column for ${id} and phase13BudgetKeysFor disagree`);
    for (const key of mapped) {
      assert(key in PHASE13_RULES, `${id} names a budget ${key} the module does not carry`);
    }
    // AND THE SINGLE CEILING THE `measured`/`budget` PAIR IS COMPARED AGAINST IS ONE OF THEM, so the two
    // functions cannot drift from each other either.
    const one = phase13BudgetKeyFor(id);
    if (one !== undefined) {
      assert(mapped.includes(one), `${id} is measured against ${one}, which §5 does not give it`);
    } else {
      assert(mapped.length !== 1, `${id} has exactly one documented budget and no ceiling reads it`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------
h.section('the closure function, DRIVEN to its boundaries');
// ---------------------------------------------------------------------------------------------------------

/** An honest, complete, real-mode result set. Every test below is this with one thing changed. */
function honest(): { mode: 'real' | 'fake'; results: Phase13GateResult[] } {
  const results: Phase13GateResult[] = [];
  for (const id of PHASE13_CLOSURE_GATE_IDS) {
    if (id.startsWith('P13-A4-')) {
      results.push({ gate: id, verdict: 'pass', measured: 2, perObjectDenominator: 2 });
      continue;
    }
    const key = phase13BudgetKeyFor(id);
    // THE SECOND BUDGET §5 GIVES THREE CLAIMS IS CARRIED BY ITS OWN NAMED FIELD, because the pair on the
    // result is ONE number and §5's column names two.
    const second = id.startsWith('P13-A7-') ? { residueSurviving: 0 }
      : id.startsWith('P13-S1-') || id.startsWith('P13-S2-') ? { consecutiveFreshRuns: 3 }
        : {};
    results.push(key === undefined
      ? { gate: id, verdict: 'pass', ...second }
      : { gate: id, verdict: 'pass', measured: 0, budget: PHASE13_RULES[key], ...second });
  }
  return { mode: 'real', results };
}

test('an honest complete real run has no problems, so the refusals below are about what changed', () => {
  assertEq(phase13ClosureProblems(honest()).join(' | '), '', 'an honest run was refused');
  assertEq(phase13Closed(honest()), true, 'an honest run did not close');
});

test('A FAKE RUN MAY NOT RECORD A TIER A VERDICT, and that is the first thing checked', () => {
  const fake = { ...honest(), mode: 'fake' as const };
  const problems = phase13ClosureProblems(fake);
  assert(problems.some((one) => /provider-free rehearsal may not record one/.test(one)),
    'a fake run recorded the eight provider-facing arms and the closure function accepted it');
  assertEq(phase13Closed(fake), false, 'a fake run closed Phase 13');
});

test('every foreign id is refused, by id and by prefix, and P11-R1 has no half', () => {
  for (const foreign of [...PHASE13_FORBIDDEN_EMITTABLE_IDS,
    'P9-anything', 'P10-anything', 'P11-anything', 'P12-anything', 'P13PRE-anything']) {
    const run = honest();
    run.results.push({ gate: foreign, verdict: 'pass' });
    const problems = phase13ClosureProblems(run);
    assert(problems.some((one) => one.includes(foreign) && /belongs to another tranche/.test(one)),
      `${foreign} was accepted as a verdict this phase may write`);
  }
  // AND THE SENTENCE IS THE STRUCTURAL FORM OF PHASE 12 §13.1's SUPERSESSION.
  const run = honest();
  run.results.push({ gate: 'P11-R1-real-mixed-generation-on-the-appliance', verdict: 'pass' });
  assert(phase13ClosureProblems(run).some((one) => /no provider half of P11-R1 to close/.test(one)),
    'the refusal does not say why there is no half');
});

test('a skip, an absent verdict, a duplicate, an invented budget and an over-budget pass are all refused', () => {
  const skip = honest();
  skip.results[0] = { ...skip.results[0]!, verdict: 'skip' };
  assert(phase13ClosureProblems(skip).some((one) => /skipped/.test(one)), 'a skip was folded into a pass');

  const absent = honest();
  absent.results.splice(2, 1);
  assert(phase13ClosureProblems(absent).some((one) => /has no verdict, and an absent verdict is not a pass/.test(one)),
    'an absent verdict read as a pass');

  const duplicate = honest();
  duplicate.results.push({ ...duplicate.results[0]! });
  assert(phase13ClosureProblems(duplicate).some((one) => /more than one verdict/.test(one)),
    'a duplicate verdict read as a confirmation');

  const invented = honest();
  invented.results[1] = { ...invented.results[1]!, measured: 0, budget: 0 };
  assert(phase13ClosureProblems(invented).some((one) => /a budget §5.3 does not give it/.test(one)),
    'a claim with nothing to measure supplied a measurement and was accepted');

  const over = honest();
  const key = phase13BudgetKeyFor(PHASE13_CLOSURE_GATE_IDS[2])!;
  over.results[2] = { gate: PHASE13_CLOSURE_GATE_IDS[2], verdict: 'pass', measured: 1, budget: PHASE13_RULES[key] };
  assert(phase13ClosureProblems(over).some((one) => /passed while reporting 1 against a budget of 0/.test(one)),
    'a pass over its own budget was accepted');

  const wrongBudget = honest();
  wrongBudget.results[2] = { gate: PHASE13_CLOSURE_GATE_IDS[2], verdict: 'pass', measured: 0, budget: 5 };
  assert(phase13ClosureProblems(wrongBudget).some((one) => /rather than against the contract's/.test(one)),
    'a verdict measured against a budget this phase did not set was accepted');
});

test('P13-A4 IS REFUSED IN BOTH DIRECTIONS, AND A RATIO WITH NO DENOMINATOR IS REFUSED TOO', () => {
  const at = PHASE13_CLOSURE_GATE_IDS.indexOf('P13-A4-exactly-one-resolution-per-object');
  const withResolutions = (measured: number, objects?: number): readonly string[] => {
    const run = honest();
    run.results[at] = {
      gate: PHASE13_CLOSURE_GATE_IDS[at]!, verdict: 'pass', measured, perObjectDenominator: objects,
    };
    return phase13ClosureProblems(run);
  };
  // ZERO IS THE ONE THAT MATTERS: a run that contacted nothing satisfies every other number in the contract.
  assert(withResolutions(0, 2).some((one) => /never contacted at all/.test(one)),
    'a run that resolved nothing passed the claim that says the provider was contacted');
  assert(withResolutions(1, 2).some((one) => /every object must cost at least one/.test(one)),
    'a run that resolved one of two objects passed');
  assertEq(withResolutions(2, 2).join(' | '), '', 'exactly one per object was refused');
  assert(withResolutions(3, 2).some((one) => /resolution storm/.test(one)),
    'a resolution storm against a metered endpoint passed');
  assert(withResolutions(2, undefined).some((one) => /no denominator/.test(one)),
    'a per-object rate with no object count was accepted, and a ratio with no denominator is a number');
  assert(withResolutions(2, 0).some((one) => /no denominator/.test(one)),
    'a zero object count was accepted as a denominator');
});

test('EVERY BUDGET §5 NAMES IS ACTUALLY READ, driven one threshold at a time', () => {
  // A STRUCTURAL AGREEMENT IS NOT ENOUGH ON ITS OWN. `phase13BudgetKeysFor` could name a threshold the
  // closure function never looks at, which is exactly the shape of the defect: `RESIDUE_MAX` was in
  // `PHASE13_RULES`, in §5.3's table and in §5.1's Budget column for `P13-A7`, and NO FUNCTION READ IT. So
  // every documented budget is driven past its own edge here and the refusal is required to arrive.
  const at = (id: string): number => PHASE13_CLOSURE_GATE_IDS.indexOf(id as never);
  const drive = (id: string, patch: Partial<Phase13GateResult>): readonly string[] => {
    const run = honest();
    run.results[at(id)] = { ...run.results[at(id)]!, ...patch } as Phase13GateResult;
    return phase13ClosureProblems(run);
  };
  const A7 = 'P13-A7-the-host-is-left-as-it-was-found';
  const S1 = 'P13-S1-three-consecutive-fresh-real-runs-zero-skips';
  const S2 = 'P13-S2-the-candidate-carries-a-phase-12-go-of-its-own';

  // `RESIDUE_MAX` — the budget §5.1 gives `P13-A7`'s residue half, over and unmeasured.
  assert(drive(A7, { residueSurviving: 1 }).some((one) => /surviving artefact/.test(one)),
    'a run that left something behind passed P13-A7 on a set-loss count of zero');
  assert(drive(A7, { residueSurviving: undefined }).some((one) => /residue nobody counted/.test(one)),
    'P13-A7 passed without measuring what survived');
  // `HOST_SET_LOSSES_MAX` is still the ceiling the pair on the result is compared against.
  assert(drive(A7, { measured: 1 }).some((one) => /against a budget of 0/.test(one)),
    'a set loss was admitted');

  // `CONSECUTIVE_FRESH_RUNS` — a FLOOR, and the only one either sequence claim has. Every ceiling in this
  // contract is satisfied by ONE run with no skips.
  for (const id of [S1, S2]) {
    for (const runs of [0, 1, 2]) {
      assert(drive(id, { consecutiveFreshRuns: runs }).some((one) => /consecutive fresh run/.test(one)),
        `${id} passed on ${runs} run(s), so "three consecutive fresh" is a title rather than a measurement`);
    }
    assert(drive(id, { consecutiveFreshRuns: undefined }).some((one) => /how many consecutive fresh runs/.test(one)),
      `${id} passed without counting its runs at all`);
  }

  // `SKIPPED_CLAIMS_MAX` — the ceiling §5.2 gives `P13-S2`, which the function used to refuse outright.
  assertEq(phase13BudgetKeyFor(S2), 'SKIPPED_CLAIMS_MAX', 'P13-S2 has no ceiling');
  assert(drive(S2, { measured: 1 }).some((one) => /against a budget of 0/.test(one)),
    'a Phase 12 sequence that skipped a claim still satisfied P13-S2');
});

test('NO THRESHOLD IN THE CONTRACT IS ONE NOTHING CAN MOVE — the D3 class, closed', () => {
  // PHASE 12 FOUND THIS IN THE PRE-ENTRY TRANCHE: `P13PRE-C3` had a budget and nothing could move it. It
  // recurred here — `REPAIRS_WITHOUT_A_CONTROL_MAX` was in `PHASE13_RULES` and in §5.3's table, was named by
  // no claim's Budget column and was read by no function at all. A threshold nothing can move is a threshold
  // that cannot fail, and a contract's own table is the last place that should be true.
  const namedByAClaim = new Set<string>();
  for (const id of PHASE13_CLOSURE_GATE_IDS) for (const key of phase13BudgetKeysFor(id)) namedByAClaim.add(key);

  // The entry gate is the other reader, and it is DRIVEN rather than grepped: each threshold below is proved
  // to be readable by producing the refusal only it can produce.
  const readByAnEntryCriterion = new Map<string, () => boolean>([
    ['ORIGIN_RECORD_MAX_AGE_MINUTES', () => phase13EntryRefusals(
      { ...ready(), originRecheckAgeMinutes: PHASE13_RULES.ORIGIN_RECORD_MAX_AGE_MINUTES + 1 },
    ).some((one) => one.startsWith('E7:') && /minutes old/.test(one))],
    ['ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES', () => phase13EntryRefusals({
      ...ready(),
      originPlan: { ...ready().originPlan, boundedSequenceDurationMinutes: 35 },
    }).some((one) => /margin/.test(one))],
    ['REPAIRS_WITHOUT_A_CONTROL_MAX', () => phase13EntryRefusals(
      { ...ready(), repairsWithoutAControlInCandidate: PHASE13_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX + 1 },
    ).some((one) => one.includes('(repairsWithoutAControlInCandidate)'))],
    ['CONSECUTIVE_FRESH_RUNS', () => phase13EntryRefusals(
      { ...ready(), phase12SequencesFromThisCandidate: PHASE13_RULES.CONSECUTIVE_FRESH_RUNS - 1 },
    ).some((one) => one.startsWith('E4:'))],
  ]);
  for (const [key, driver] of readByAnEntryCriterion) {
    assert(driver(), `${key} is in PHASE13_RULES and nothing this suite can drive reads it`);
  }
  for (const key of Object.keys(PHASE13_RULES)) {
    assert(namedByAClaim.has(key) || readByAnEntryCriterion.has(key),
      `${key} is a budget no claim names and no criterion reads, so nothing can ever move it`);
  }
});

// ---------------------------------------------------------------------------------------------------------
h.section('§6 — the entry criteria, and the field nobody filled in');
// ---------------------------------------------------------------------------------------------------------

/** A state in which every entry criterion is met. Each test below is this with one thing removed. */
function ready(): Phase13EntryState {
  return {
    contractCommitted: true,
    phase12Amended: true,
    candidate: 'a8d7232',
    stagedFilesDiffering: 0,
    stagedTextFilesWithCarriageReturn: 0,
    phase12SequencesFromThisCandidate: 3,
    phase12SkipsInThoseSequences: 0,
    operatorInputsPresent: true,
    operatorSecretsDistinctAndRestricted: true,
    operatorConfirmedEntitledObjectByReference: true,
    allowlistRecordTaken: true,
    allowedOriginCount: 7,
    originRecheckExitStatus: 0,
    originRecheckAgeMinutes: 5,
    otherGateCampaignRunning: false,
    projectionContainersOnHost: 0,
    gatePortsFree: true,
    baselineTakenImmediatelyBefore: true,
    repairsWithoutAControlInCandidate: 0,
    originPlan: {
      shortestObservedOriginLifetimeMinutes: 40,
      boundedSequenceDurationMinutes: 20,
      originRecordAgeMinutes: 5,
      observedPoolSize: 7,
      allowedOriginCount: 7,
    },
  };
}

test('a fully evaluated ready state is admitted, so the refusals below are about what changed', () => {
  assertEq(phase13EntryRefusals(ready()).join(' | '), '', 'a ready state was refused');
  assertEq(phase13MayEnter(ready()), true, 'a ready state may not enter');
});

test('AN UNEVALUATED CRITERION IS REFUSED AS LOUDLY AS A FAILED ONE, field by field', () => {
  // THE FAILURE MODE OF AN ENTRY GATE IS NOT A CRITERION ANSWERED WRONGLY. It is a criterion nobody filled
  // in — and a required field with a permissive default is a field a caller can forget. So every field is
  // dropped in turn and the empty state is asserted to refuse.
  const keys = Object.keys(ready()) as Array<keyof Phase13EntryState>;
  assert(keys.length >= 18, `the ready state has only ${keys.length} fields, so this sweep is not thorough`);
  for (const key of keys) {
    const partial = { ...ready() };
    delete partial[key];
    assert(phase13EntryRefusals(partial).length > 0,
      `dropping ${String(key)} left every entry criterion satisfied, so nothing measures it`);
  }
  // AND AN EMPTY STATE REFUSES ON EVERY CRITERION, rather than on the first one it happens to reach.
  const empty = phase13EntryRefusals({});
  for (const criterion of PHASE13_ENTRY_CRITERIA) {
    assert(empty.some((one) => one.startsWith(`${criterion}`)),
      `an entirely unevaluated state produced no refusal for ${criterion}`);
  }
});

test('EVERY REFUSAL IS DISTINCT AND NAMES THE FIELD SOMEBODY HAS TO GO AND FILL IN', () => {
  // FOUND BY RUNNING THIS FUNCTION RATHER THAN BY READING IT, while driving the campaign's own entry state.
  // Several criteria are carried by more than one field — E5 by three, E8 by four — and a message built only
  // from the criterion label produced TWO IDENTICAL SENTENCES for two different unevaluated things. A reader
  // working through the list cannot tell which field to fill in, and a list with a repeated line reads as a
  // rendering bug rather than as two findings.
  const empty = phase13EntryRefusals({});
  assertEq(new Set(empty).size, empty.length,
    `two entry refusals are the same sentence, so one of them names nothing actionable:\n${empty.join('\n')}`);
  // AND EVERY FIELD OF THE READY STATE APPEARS BY NAME IN THE REFUSAL ITS ABSENCE PRODUCES.
  for (const key of Object.keys(ready()) as Array<keyof Phase13EntryState>) {
    const partial = { ...ready() };
    delete partial[key];
    const added = phase13EntryRefusals(partial);
    if (key === 'originPlan' || key === 'candidate' || key === 'allowedOriginCount'
      || key === 'originRecheckExitStatus' || key === 'originRecheckAgeMinutes'
      || key === 'phase12SequencesFromThisCandidate' || key === 'otherGateCampaignRunning') {
      // These seven are refused by a sentence of their own that already says which measurement is missing.
      assert(added.length > 0, `dropping ${String(key)} produced no refusal`);
      continue;
    }
    assert(added.some((one) => one.includes(`(${String(key)})`)),
      `dropping ${String(key)} produced a refusal that does not name the field: ${added.join(' | ')}`);
  }
});

test('E4 refuses a candidate that inherited another commit\'s Phase 12 GO', () => {
  // THE CRITERION MOST LIKELY TO BE ARGUED WITH. Phase 12's GO is a closed record about `a8d7232`, and
  // between that commit and any candidate carrying the pre-entry repair the STAGING SCRIPT that is arms 1
  // and 2 of every sequence moved, along with the gate arm 7 runs and two suites arm 9 reads.
  for (const sequences of [0, 1, 2]) {
    const refusals = phase13EntryRefusals({ ...ready(), phase12SequencesFromThisCandidate: sequences });
    assert(refusals.some((one) => one.startsWith('E4:') && /does not transfer to a descendant/.test(one)),
      `${sequences} complete Phase 12 sequence(s) from this candidate was admitted`);
  }
  assert(phase13EntryRefusals({ ...ready(), phase12SkipsInThoseSequences: 1 })
    .some((one) => one.startsWith('E4 ')), 'a Phase 12 sequence that skipped an arm was admitted');
});

test('E7 tells a rotation from a failure to measure, and neither is a licence to widen anything', () => {
  const rotated = phase13EntryRefusals({ ...ready(), originRecheckExitStatus: 70 });
  assert(rotated.some((one) => /BLOCKER/.test(one) && /NEVER resolved by editing the allowlist/.test(one)),
    'a rotated origin was not refused as a blocker, or the refusal does not forbid the widening');
  for (const status of [1, 2, 127]) {
    assert(phase13EntryRefusals({ ...ready(), originRecheckExitStatus: status })
      .some((one) => /NOT MEASURED/.test(one)), `exit ${status} was not read as "not measured"`);
  }
  assert(phase13EntryRefusals({ ...ready(), originRecheckAgeMinutes: ORIGIN_RECORD_MAX_AGE_MINUTES + 1 })
    .some((one) => one.startsWith('E7:')), 'a stale origin recheck was admitted');
  assertEq(phase13EntryRefusals({ ...ready(), originRecheckAgeMinutes: ORIGIN_RECORD_MAX_AGE_MINUTES })
    .join(' | '), '', 'a recheck exactly at the maximum age was refused');
});

test('E9 reads the pre-entry module\'s own origin policy rather than a copy of it', () => {
  // A SEQUENCE THAT DOES NOT FIT INSIDE ONE ORIGIN TURN, with the margin the policy requires.
  const tooLong = phase13EntryRefusals({
    ...ready(),
    originPlan: { ...ready().originPlan!, boundedSequenceDurationMinutes: 35 },
  });
  assert(tooLong.some((one) => one.startsWith('E9:')),
    'a sequence longer than the shortest observed origin turn minus the margin was admitted');
  // AND A POOL LARGER THAN THE ALLOWLIST, where a rotation out of it is certain given enough time.
  assert(phase13EntryRefusals({ ...ready(), originPlan: { ...ready().originPlan!, observedPoolSize: 9 } })
    .some((one) => one.startsWith('E9:')), 'a pool larger than the allowlist was admitted');
});

test('E6 AND E9 CARRY TWO COPIES OF ONE FACT, AND THE HEADLINE BLOCKER CANNOT BE ERASED BY THE SECOND', () => {
  // THE CAMPAIGN'S OWN REAL FIGURES. §14.2.2 records an allowlist of SIX members; §14.3 records a pool
  // observed serving from SEVEN, and calls that refusal "the one that matters most". E6 reads
  // `allowedOriginCount` and E9 reads `originPlan.allowedOriginCount` — two independently supplied copies of
  // ONE fact — and while nothing asserted they agree, filling the plan's copy in as SEVEN made the
  // six-against-seven refusal DISAPPEAR and `phase13MayEnter` returned true. No provider fact had to move.
  const real: Phase13EntryState = {
    ...ready(),
    allowedOriginCount: 6,
    originPlan: { ...ready().originPlan!, allowedOriginCount: 7, observedPoolSize: 7 },
  };
  const refusals = phase13EntryRefusals(real);
  assert(refusals.some((one) => one.startsWith('E6/E9')
    && one.includes('(allowedOriginCount, originPlan.allowedOriginCount)')),
    'two disagreeing copies of the allowlist count were admitted, and the E9 blocker vanished with them');
  assertEq(phase13MayEnter(real), false, 'a divergent allowlist count authorised entry');

  // AND WITH THE COPIES AGREEING, THE BLOCKER §14.3 NAMES IS BACK, stated as the pool against the allowlist.
  const honestCounts: Phase13EntryState = {
    ...ready(),
    allowedOriginCount: 6,
    originPlan: { ...ready().originPlan!, allowedOriginCount: 6, observedPoolSize: 7 },
  };
  assert(phase13EntryRefusals(honestCounts).some((one) => one.startsWith('E9:')
    && /WIDENING THE ALLOWLIST IS A BLOCKER AND NOT A STEP/.test(one)),
    'the six-against-seven blocker is not raised when the two copies agree');
  // THE REFUSAL IS NEVER A RECONCILIATION. Picking one of the two numbers would be this module deciding
  // which of the operator's measurements is real.
  assert(!phase13EntryRefusals(real).some((one) => /widen/i.test(one) && /allowlist to/i.test(one)),
    'a refusal suggested moving the allowlist');
});

test('AN UNMEASURED POOL IS NOT A SMALL ONE, and a zero is still a measurement', () => {
  // THE ONE FIELD WHERE NOT MEASURED USED TO READ AS SATISFIED. `originStabilityRefusals` guards its pool
  // comparison with `typeof allowed === 'number' && typeof pool === 'number'`, so an ABSENT
  // `observedPoolSize` — or an absent plan-side `allowedOriginCount` — produced NO refusal at all, while an
  // unmeasured lifetime, an unbounded duration and an ageless record are each refused there BY NAME.
  //
  // IT IS REFUSED AT E9's OWN SITE RATHER THAN INSIDE THE IMPORTED FUNCTION, and that is not a preference:
  // `phase13-preentry.ts` is on `PHASE13_FORBIDDEN_SOURCE` and §4's ninth refusal forbids this tranche from
  // editing the instrument it is measured through.
  for (const field of ['observedPoolSize', 'allowedOriginCount'] as const) {
    const plan: Record<string, unknown> = { ...ready().originPlan! };
    delete plan[field];
    const state = { ...ready(), originPlan: plan } as Phase13EntryState;
    assert(phase13EntryRefusals(state).some((one) => one.includes(`(originPlan.${field})`)),
      `a plan with no ${field} was admitted, so an unmeasured pool read as a satisfied one`);
    assertEq(phase13MayEnter(state), false, `an incomplete origin plan authorised entry (${field})`);
  }
  // AND NEITHER IS A NUMBER THAT IS NOT A COUNT.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const state = {
      ...ready(), originPlan: { ...ready().originPlan!, observedPoolSize: bad },
    };
    assert(phase13EntryRefusals(state).some((one) => one.includes('(originPlan.observedPoolSize)')),
      `a pool size of ${String(bad)} was admitted as a measurement`);
  }
  // A ZERO IS STILL A MEASUREMENT AND IS NOT REFUSED HERE. E6's own criterion is what refuses an allowlist
  // admitting nobody, and it names its own field when it does.
  const zeroed = {
    ...ready(), allowedOriginCount: 0,
    originPlan: { ...ready().originPlan!, allowedOriginCount: 0, observedPoolSize: 0 },
  };
  assert(!phase13EntryRefusals(zeroed).some((one) => one.includes('(originPlan.observedPoolSize)')),
    'an observed pool of zero was refused as unmeasured, which it is not');
  assert(phase13EntryRefusals(zeroed).some((one) => one.startsWith('E6:')),
    'an allowlist admitting no member was admitted');
});

test('THE FIELD-DROP SWEEP REACHES INSIDE THE ORIGIN PLAN, which is where it used to stop', () => {
  // WHY THE OLD SWEEP MISSED F2. It iterated the TOP-LEVEL keys of `Phase13EntryState` only, and E9's whole
  // criterion arrives as ONE of them. Dropping `originPlan` refused; dropping a field INSIDE it did not.
  const plan = ready().originPlan!;
  const keys = Object.keys(plan);
  assert(keys.length >= 5, `the plan has only ${keys.length} fields, so this sweep is not thorough`);
  for (const key of keys) {
    const partial: Record<string, unknown> = { ...plan };
    delete partial[key];
    const state = { ...ready(), originPlan: partial } as Phase13EntryState;
    assert(phase13EntryRefusals(state).length > 0,
      `dropping originPlan.${key} left every entry criterion satisfied, so nothing measures it`);
    assertEq(phase13MayEnter(state), false, `an origin plan missing ${key} authorised entry`);
  }
});

test('E5 never asks for a value, and the refusals name a shape rather than a secret', () => {
  const refusals = phase13EntryRefusals({});
  for (const refusal of refusals) {
    // THE FIELD NAME IN PARENTHESES IS STRIPPED FIRST, AND IT IS NOT AN EXEMPTION. A refusal names the field
    // somebody has to go and fill in — `stagedTextFilesWithCarriageReturn` is twenty-eight characters and
    // matches the value shape exactly — and a schema key is a schema, not a secret. What must not appear is
    // a value, so the check is over everything the refusal says APART from the key it names.
    const body = refusal.replace(/\([A-Za-z][A-Za-z0-9]*\)/g, '(field)');
    assert(!/[A-Za-z0-9_-]{24,}/.test(body),
      `an entry refusal carries a value-shaped string, which is what a token and a reference both look like: ${refusal}`);
    assert(!/[a-z][a-z0-9+.-]*:\/\//i.test(body), `an entry refusal carries a URL: ${refusal}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
h.section('§7 — the exit criteria, which used to be six labels');
// ---------------------------------------------------------------------------------------------------------

/** A complete, honest exit state. Every test below is this with one thing changed. */
function exited(): Phase13ExitState {
  return {
    wrapperRunsCompleted: 3,
    wrapperRunsSkipped: 0,
    wrapperExitStatus: 0,
    candidate: 'a8d7232',
    credentialReadPrintedOrChanged: false,
    providerOutageInduced: false,
    allowlistWholeFileDigestUnchanged: true,
    allowlistMemberDigestsUnchanged: true,
    allowlistMembersMoved: 0,
    hostSetLosses: 0,
    residueSurviving: 0,
    applianceUntouched: true,
    tamperedEvidenceStillRefused: true,
  };
}

test('a complete honest exit state satisfies §7, so the refusals below are about what changed', () => {
  assertEq(phase13ExitRefusals(honest(), exited()).join(' | '), '', 'an honest exit was refused');
  assertEq(phase13ExitSatisfied(honest(), exited()), true, 'an honest exit did not satisfy §7');
});

test('§7 IS CODE RATHER THAN SIX LABELS, and every criterion refuses by name', () => {
  // WHAT THIS REPLACES. §13's ownership row says this module carries "§6's entry criteria and §7's exit
  // criteria, as code". §6 had a function; §7 had `PHASE13_EXIT_CRITERIA` — six strings — and a check that
  // each label has a row in the document. X3 ("no credential was read…") and X5 ("the host is left as it
  // was found") had NO executable counterpart at all.
  const empty = phase13ExitRefusals({ mode: 'fake', results: [] }, {});
  for (const criterion of PHASE13_EXIT_CRITERIA) {
    assert(empty.some((one) => one.startsWith(criterion)),
      `an entirely unevaluated exit state produced no refusal for ${criterion}`);
  }
  // AND EVERY FIELD IS SWEPT, because the failure mode of an exit gate is the same as an entry gate's: a
  // criterion nobody filled in.
  const keys = Object.keys(exited()) as Array<keyof Phase13ExitState>;
  assert(keys.length >= 13, `the exit state has only ${keys.length} fields, so this sweep is not thorough`);
  for (const key of keys) {
    const partial = { ...exited() };
    delete partial[key];
    assert(phase13ExitRefusals(honest(), partial).length > 0,
      `dropping ${String(key)} left every exit criterion satisfied, so nothing measures it`);
  }
});

test('X2 AND X6 ARE READ OFF THE EVIDENCE, not declared beside it', () => {
  // A DECLARATION ABOUT VERDICTS IS A SECOND COPY OF THE VERDICTS, and the two can disagree. X2 and X6 are
  // therefore computed from the result set the run actually produced.
  const fake = { ...honest(), mode: 'fake' as const };
  assert(phase13ExitRefusals(fake, exited()).some((one) => one.startsWith('X2:')),
    'a provider-free rehearsal satisfied X2');
  const missing = honest();
  missing.results.splice(0, 1);
  assert(phase13ExitRefusals(missing, exited()).some((one) => one.startsWith('X2 (P13-A1-')),
    'a Tier A claim with no verdict satisfied X2');
  const skipped = honest();
  skipped.results[0] = { ...skipped.results[0]!, verdict: 'skip' };
  assert(phase13ExitRefusals(skipped, exited()).some((one) => one.startsWith('X2 (P13-A1-')),
    'a skipped Tier A claim satisfied X2');
  // X6 IS BOTH HALVES: the closure function empty, AND the same evidence with one byte changed refused.
  assert(phase13ExitRefusals(skipped, exited()).some((one) => one.startsWith('X6:')),
    'X6 passed while phase13ClosureProblems had something to say');
  assert(phase13ExitRefusals(honest(), { ...exited(), tamperedEvidenceStillRefused: false })
    .some((one) => one.startsWith('X6 (tamperedEvidenceStillRefused)')),
    'a green nobody proved is about anything satisfied X6');
});

test('X1, X3, X4 and X5 refuse in the direction that would let a GO be written', () => {
  const refused = (state: Phase13ExitState, prefix: string, why: string): void => {
    assert(phase13ExitRefusals(honest(), state).some((one) => one.startsWith(prefix)), why);
  };
  for (const runs of [0, 1, 2]) {
    refused({ ...exited(), wrapperRunsCompleted: runs }, 'X1 (wrapperRunsCompleted)',
      `${runs} completed run(s) satisfied X1`);
  }
  refused({ ...exited(), wrapperRunsSkipped: 1 }, 'X1 (wrapperRunsSkipped)', 'a skipped run satisfied X1');
  refused({ ...exited(), wrapperExitStatus: 77 }, 'X1 (wrapperExitStatus)', 'exit 77 satisfied X1');
  refused({ ...exited(), candidate: 'not-a-commit' }, 'X1 (candidate)', 'an unnamed candidate satisfied X1');
  refused({ ...exited(), credentialReadPrintedOrChanged: true }, 'X3 (credentialReadPrintedOrChanged)',
    'a run that read a credential satisfied X3');
  refused({ ...exited(), providerOutageInduced: true }, 'X3 (providerOutageInduced)',
    'a run that induced an outage satisfied X3');
  refused({ ...exited(), allowlistWholeFileDigestUnchanged: false }, 'X4', 'a moved allowlist satisfied X4');
  refused({ ...exited(), allowlistMemberDigestsUnchanged: false }, 'X4', 'a moved member satisfied X4');
  refused({ ...exited(), allowlistMembersMoved: 1 }, 'X4 (allowlistMembersMoved)', 'a widening satisfied X4');
  refused({ ...exited(), hostSetLosses: 1 }, 'X5 (hostSetLosses)', 'a set loss satisfied X5');
  refused({ ...exited(), residueSurviving: 1 }, 'X5 (residueSurviving)', 'surviving residue satisfied X5');
  refused({ ...exited(), applianceUntouched: false }, 'X5 (applianceUntouched)',
    'a moved appliance satisfied X5');
});

test('NO EXIT REFUSAL CARRIES A VALUE, A URL OR A MEMBER', () => {
  for (const refusal of phase13ExitRefusals({ mode: 'fake', results: [] }, {})) {
    const body = refusal.replace(/\([A-Za-z][A-Za-z0-9-]*\)/g, '(field)');
    assert(!/[a-z][a-z0-9+.-]*:\/\//i.test(body), `an exit refusal carries a URL: ${refusal}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
h.section('the document and the module say the same thing');
// ---------------------------------------------------------------------------------------------------------

test('the document still carries every preserved state, word for word', () => {
  const contract = flat(CONTRACT);
  for (const sentence of PHASE13_PRESERVED_STATES) {
    assert(contract.includes(sentence), `§2.1 no longer says: ${sentence}`);
  }
});

test('the document still carries the ceiling sentence and the meaning', () => {
  const contract = flat(CONTRACT);
  assert(contract.includes(PHASE13_CEILING_SENTENCE), '§2.3 no longer carries the ceiling sentence');
  // THE MEANING IS COMPARED IN PIECES, because the document renders it as a block quote across lines and a
  // whitespace-flattened comparison of one long sentence is a comparison of the wrapping.
  for (const fragment of PHASE13_MEANING.split(', ')) {
    assert(contract.includes(fragment.replace(/\.$/, '')), `§2.3 no longer says: ${fragment}`);
  }
});

test('THE PROVIDER-NEUTRAL WORDING OF §2.3 STOPS AT §2.3, and §3.1 and §5.1 still pin the instrument', () => {
  // WHAT THIS IS A CONTROL FOR, AND IT IS A RESIDUAL RATHER THAN A REPAIR. The commit that ADDED
  // `phase13.ts` also edited §2.3's GO-meaning block quote, dropping the provider's name and the host
  // vendor's, so that `PHASE13_MEANING` could carry the sentence without putting the provider's name in
  // `src/` — where it would have required all eight provider source allowlists to move for a string. That
  // edit ran in the WIDENING direction and it was made in the implementation commit rather than the
  // contract commit, which is recorded in §2.3 rather than rewritten: history is not falsified here.
  //
  // WHAT THE CONTROL PREVENTS is the widening spreading. §3.1 names the two gate scripts, the operator's own
  // Unraid host and the operator's own TorBox account; §5.1 names the TorBox credential and the TorBox
  // stable references. If a later summary neutralises those the way §2.3 was neutralised, this fails.
  const contract = flat(CONTRACT);
  for (const pin of ['operator\'s real Unraid host', 'own already-served TorBox account',
    'deploy/projection-torbox-real-gate.sh', 'deploy/projection-torbox-real-gate-three.sh']) {
    assert(contract.includes(pin), `§3.1 no longer pins the instrument: ${pin}`);
  }
  for (const pin of ['the TorBox credential is **absent from the daemon container\'s filesystem**',
    'operator\'s TorBox stable references']) {
    assert(contract.includes(pin), `§5.1 no longer pins the provider: ${pin}`);
  }
  // AND THE MODULE STILL NAMES NEITHER, which is the reason the sentence was neutralised in the first place
  // and is asserted here beside the pins rather than a hundred lines away from them.
  const module = read(MODULE);
  for (const name of ['TorBox', 'torbox', 'Unraid', 'unraid']) {
    assert(!module.includes(name), `${MODULE} names ${name}, so a source allowlist has to move for a string`);
  }
  assert(!PHASE13_MEANING.includes('TorBox') && !PHASE13_MEANING.includes('Unraid'),
    'PHASE13_MEANING names the provider or the host vendor');
});

test('the document still states every non-claim, so a summary cannot grow one', () => {
  const contract = flat(CONTRACT).toLowerCase();
  for (const nonclaim of PHASE13_NONCLAIMS) {
    assert(contract.includes(nonclaim.toLowerCase()), `§2.4 no longer says Phase 13 is not ${nonclaim}`);
  }
});

test('every entry and exit criterion the module names is a row in the document, and no more', () => {
  const contract = read(CONTRACT);
  for (const criterion of PHASE13_ENTRY_CRITERIA) {
    assert(contract.includes(`| **${criterion}** |`), `§6 has no row for ${criterion}`);
  }
  for (const criterion of PHASE13_EXIT_CRITERIA) {
    assert(contract.includes(`| **${criterion}** |`), `§7 has no row for ${criterion}`);
  }
  // AND THE DOCUMENT NAMES NO CRITERION THE FUNCTION CANNOT REFUSE. A row nothing measures is the defect
  // Phase 12's D3 found in the pre-entry tranche: a budget with nothing behind it.
  const known = new Set([...PHASE13_ENTRY_CRITERIA, ...PHASE13_EXIT_CRITERIA]);
  for (const match of contract.matchAll(/\| \*\*([EX]\d+)\*\* \|/g)) {
    assert(known.has(match[1]!), `the document names ${match[1]} and the module does not`);
  }
});

test('§14 records that PHASE 13 IS NOT RUN, and no Tier A verdict exists anywhere in it', () => {
  const contract = flat(CONTRACT);
  assert(/Phase 13 \| \*\*NOT RUN\. NOT ENTERED\.\*\*/.test(contract),
    '§14.1 no longer records Phase 13 as NOT RUN');
  assert(/Provider contact \| \*\*none, ever, by this repository\*\*/.test(contract),
    '§14.1 no longer records that no provider has been contacted');
  // AND NO CLAIM CARRIES A VERDICT. A document that started saying "pass" beside a Tier A id would be a
  // document recording a run nobody made.
  for (const id of PHASE13_ACCEPTANCE_GATE_IDS) {
    assert(!new RegExp(`\`${id}\`[^|]*\\|[^|]*\\bpass\\b`).test(contract),
      `${id} carries a pass verdict in a document whose status is NOT RUN`);
  }
});

// ---------------------------------------------------------------------------------------------------------
h.section('ownership, the soak question, and the boundary that did not move');
// ---------------------------------------------------------------------------------------------------------

/** Every path in the document's §13 ownership table. The parse fails loudly rather than returning nothing. */
function ownershipTablePaths(): readonly string[] {
  return ownershipSectionOf(read(CONTRACT));
}

/**
 * §13's table, and NOTHING BELOW IT.
 *
 * WHY THE SECTION IS BOUNDED, AND IT WAS FOUND BY RUNNING RATHER THAN BY READING. The first version sliced
 * from the ownership heading TO THE END OF THE DOCUMENT, which was harmless only while §14 was a stub. The
 * moment the run record grew a table naming `objects.json` and `endpoint.json` — the operator's inputs,
 * described by shape — the parse claimed them as paths this tranche owns, and the git-driven check then
 * reported two phantom rows that were never in §13 at all. **A parser whose answer depends on what somebody
 * writes below it is a parser measuring the wrong thing**, and the failure was in the direction that reads
 * as a defect in the record rather than in the check.
 *
 * THE END BOUNDARY IS THE NEXT `## ` HEADING, matched with `\r?\n` so it holds in a CRLF checkout as well as
 * in the LF worktree an agent wrote it in — the same line-ending trap that cost this repository four release
 * baselines. Where there is no next heading the section runs to the end, which is correct rather than
 * lucky: there is nothing below it to swallow.
 */
function ownershipSectionOf(document: string): readonly string[] {
  const at = document.indexOf(PHASE13_OWNERSHIP_SECTION);
  assert(at >= 0, `${CONTRACT} has no section titled "${PHASE13_OWNERSHIP_SECTION}", so the complete `
    + 'ownership list cannot be read and the soak question would be asked of a subset');
  const rest = document.slice(at + PHASE13_OWNERSHIP_SECTION.length);
  const next = /\r?\n## /.exec(rest);
  const section = next === null ? rest : rest.slice(0, next.index);
  const paths: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const match = /^`([^`]+)`$/.exec(line.split('|')[1]?.trim() ?? '');
    if (match?.[1] !== undefined
      && /^[\w./-]*\.(ts|sh|json|md|yml|yaml|gitignore|gitattributes)$/.test(match[1])) {
      paths.push(match[1]);
    }
  }
  return paths;
}

test('CONTROL: the §13 parse stops at its own section, and answers the same under CRLF', () => {
  // THE DEFECT, DRIVEN. A run record written below §13 legitimately names files by shape — the operator's
  // `objects.json` and `endpoint.json` among them — and an unbounded slice claimed them as paths this
  // tranche owns. The git-driven check then reported them as rows §13 claims and the branch does not touch,
  // which reads as a defect in the record rather than in the parser.
  const real = read(CONTRACT);
  const grown = `${real}\n\n## 99. A later section that names files by shape\n\n`
    + '| Path | note |\n|---|---|\n| `objects.json` | the operator\'s own, described by shape |\n'
    + '| `endpoint.json` | the same |\n';
  assertEq(ownershipSectionOf(grown).join(','), ownershipSectionOf(real).join(','),
    'a table written BELOW §13 changed what §13 is read as claiming, so the parse is unbounded');
  assert(!ownershipSectionOf(grown).includes('objects.json'),
    'the parse claimed an operator input as a path this tranche owns');

  // AND THE SAME ANSWER IN A CRLF CHECKOUT. `.gitattributes` pins `*.sh` and `*.go` to LF and nothing else,
  // so this `.md` is LF in the worktree an agent wrote it in and CRLF in an ordinary Windows checkout of the
  // identical tree hash. A boundary matched with a bare LF would miss there and swallow the rest of the file.
  const crlf = grown.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  assertEq(ownershipSectionOf(crlf).join(','), ownershipSectionOf(real).join(','),
    'the ownership section parses differently under CRLF, so the completeness check is about a line ending');

  // AND THE PARSE IS NOT VACUOUS: it finds the whole table it is supposed to.
  assert(ownershipSectionOf(real).length >= 12,
    `the §13 parse found only ${ownershipSectionOf(real).length} rows, so it is measuring almost nothing`);
});

test('the ownership table is complete: it holds every path the module names, and more', () => {
  const table = ownershipTablePaths();
  assert(table.length >= PHASE13_TRANCHE_PATHS.length,
    'the ownership table names fewer paths than the module does, so it is not the authority it claims to be');
  for (const path of PHASE13_TRANCHE_PATHS) {
    assert(table.includes(path), `${path} is in the module's list but not in the document's §13 table`);
  }
  // AND IT NAMES THE ONE THE MODULE DELIBERATELY CANNOT, because its filename names the provider.
  assert(table.includes('deploy/projection-torbox-real-gate.sh'),
    'the gate this tranche repaired is not in the document\'s §13 table');
});

test('every path §13 claims WAS modified by this branch, driven against git, and it FAILS when it cannot ask', () => {
  // FAIL-CLOSED, for the reason the pre-entry suite gives about its own version of this check: a checkout
  // that cannot answer "was this file modified" has not answered it, and `assert(true, …)` on an
  // unanswerable question registers a PASS in a tranche whose §4 refuses to fold a skip into a pass.
  const base = /Phase 12 is GO from candidate ([0-9a-f]{7,40})/.exec(flat(CONTRACT))?.[1];
  assert(base !== undefined, 'the document names no Phase 12 candidate, so nothing says what "modified" means');
  const rev = spawnSync('git', ['rev-parse', '--verify', `${base}^{commit}`],
    { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
  assertEq(rev.status, 0,
    `the Phase 12 candidate ${String(base)} cannot be resolved in this checkout, so the ownership table is `
    + 'UNCHECKED rather than complete. This fails closed: an unasked question is not an answered one');
  const diff = spawnSync('git', ['diff', '--name-only', `${base}..HEAD`],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
  assertEq(diff.status, 0, 'git could not list what this branch changed');
  const changed = new Set(String(diff.stdout ?? '').split('\n').map((one) => one.trim()).filter(Boolean));
  assert(changed.size > 0, 'git reports no change at all, so this check is measuring nothing');
  const phantom = ownershipTablePaths().filter((path) => !changed.has(path));
  assertEq(phantom.length, 0, `§13 claims these paths but the branch does not touch them: ${phantom.join(', ')}`);
});

test('PHASE 9: nothing this tranche touches triggers a soak re-run', () => {
  const union = [...new Set([...PHASE13_TRANCHE_PATHS, ...ownershipTablePaths()])];
  assert(union.length > PHASE13_TRANCHE_PATHS.length,
    'the union is no larger than the module\'s list, so the table added nothing and the parse is suspect');
  assertEq(phase9RequiresSoakRerun(union), false,
    'a path this tranche modifies is on PHASE9_SOAK_TRIGGERING_SOURCE, so Phase 9\'s soak must be re-run');
});

test('the module names no provider, so no source allowlist had to be widened', () => {
  // THE DOCUMENT'S FILENAME IS PART OF THIS. `phase13.ts` carries the document's path in its ownership list,
  // so a filename that named the provider would put the provider's name in `src/` and require eight security
  // boundaries to move for a string. Phase 11 §6.2 records what that costs.
  assert(!/torbox/i.test(read(MODULE)), 'the module names the provider, so eight allowlists now have to move');
  assert(!/torbox/i.test(CONTRACT), 'the contract\'s FILENAME names the provider, and the module carries it');
});

test('the forbidden list holds the instrument this tranche is measured THROUGH', () => {
  // A TRANCHE THAT COULD EDIT THE GATE IT IS MEASURED THROUGH IS A TRANCHE WHOSE MEASUREMENT CONCLUDES
  // WHATEVER IT NEEDS TO, and a gate repaired mid-campaign is a gate the campaign did not survive.
  for (const path of ['src/core/projection/phase12.ts', 'src/core/projection/phase13-preentry.ts',
    'deploy/projection-alpha.sh', 'docker-compose.projection-alpha.yml']) {
    assert(PHASE13_FORBIDDEN_SOURCE.includes(path), `${path} is not on PHASE13_FORBIDDEN_SOURCE`);
  }
  // AND NOTHING IS ON BOTH LISTS. A path this tranche both owns and may not touch is a contradiction that
  // resolves in whichever direction somebody reads first.
  for (const path of PHASE13_TRANCHE_PATHS) {
    assert(!PHASE13_FORBIDDEN_SOURCE.includes(path),
      `${path} is both owned and forbidden, so the two lists disagree about the same file`);
  }
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase13.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase13.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

test('the tranche is reachable from a named npm script', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  assert('test:phase13' in scripts, 'test:phase13 is not an npm script, so nobody can run it the documented way');
});

await h.finish();
