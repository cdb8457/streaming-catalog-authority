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
  phase13ClosureProblems,
  phase13Closed,
  phase13EntryRefusals,
  phase13MayEnter,
  type Phase13EntryState,
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
  // THE TWO CLAIMS §5 GIVES NO BUDGET, and the one it gives a RANGE rather than a ceiling.
  assertEq(phase13BudgetKeyFor(PHASE13_CLOSURE_GATE_IDS[1]), undefined, 'P13-A2 has nothing to count');
  assertEq(phase13BudgetKeyFor(PHASE13_CLOSURE_GATE_IDS[9]), undefined, 'P13-S2 has nothing to count');
  assertEq(phase13BudgetKeyFor(PHASE13_CLOSURE_GATE_IDS[3]), undefined,
    'P13-A4 is measured against a RANGE and must not be squeezed into the single-ceiling path, which has '
    + 'nowhere to put its floor');
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
    results.push(key === undefined
      ? { gate: id, verdict: 'pass' }
      : { gate: id, verdict: 'pass', measured: 0, budget: PHASE13_RULES[key] });
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
    .some((one) => one.startsWith('E4:')), 'a Phase 12 sequence that skipped an arm was admitted');
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

test('E5 never asks for a value, and the refusals name a shape rather than a secret', () => {
  const refusals = phase13EntryRefusals({});
  for (const refusal of refusals) {
    assert(!/[A-Za-z0-9_-]{24,}/.test(refusal),
      `an entry refusal carries a value-shaped string, which is what a token and a reference both look like: ${refusal}`);
    assert(!/[a-z][a-z0-9+.-]*:\/\//i.test(refusal), `an entry refusal carries a URL: ${refusal}`);
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
  const document = read(CONTRACT);
  const at = document.indexOf(PHASE13_OWNERSHIP_SECTION);
  assert(at >= 0, `${CONTRACT} has no section titled "${PHASE13_OWNERSHIP_SECTION}", so the complete `
    + 'ownership list cannot be read and the soak question would be asked of a subset');
  const paths: string[] = [];
  for (const line of document.slice(at).split('\n')) {
    if (!line.startsWith('|')) continue;
    const match = /^`([^`]+)`$/.exec(line.split('|')[1]?.trim() ?? '');
    if (match?.[1] !== undefined
      && /^[\w./-]*\.(ts|sh|json|md|yml|yaml|gitignore|gitattributes)$/.test(match[1])) {
      paths.push(match[1]);
    }
  }
  return paths;
}

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
