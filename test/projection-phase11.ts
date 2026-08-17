import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  PHASE11_ARM_GATE_IDS,
  PHASE11_CLOSURE_GATE_IDS,
  PHASE11_FAKE_EMITTABLE_GATE_IDS,
  PHASE11_FAKE_ORIGIN_PORT,
  PHASE11_FORBIDDEN_SOURCE,
  PHASE11_GATE_PG_PORT,
  PHASE11_GATE_TITLES,
  PHASE11_NONCLAIMS,
  PHASE11_RECORDED_ENTRY_FIELDS,
  PHASE11_RULES,
  PHASE11_SEQUENCE_LEVEL_GATE_IDS,
  PHASE11_SERVER_IDS,
  PHASE11_TIER_ONE_CEILING_SENTENCE,
  PHASE11_TIER_ONE_GATE_IDS,
  PHASE11_TIER_TWO_GATE_IDS,
  PHASE11_TIER_TWO_OPERATOR_INPUTS,
  PHASE11_TRANCHE_PATHS,
  PHASE11_UNTOUCHABLE_PHASE9_CLAIMS,
  phase11BudgetKeyFor,
  phase11Closed,
  phase11ClosureProblems,
  phase11MixedGenerationProblems,
  phase11TierOf,
  phase11UndeclaredArms,
  phase11UnreachedArms,
  type Phase11GateResult,
  type Phase11Results,
  type Phase11Tier,
} from '../src/core/projection/phase11.js';
import { PHASE9_RULES, phase9RequiresSoakRerun } from '../src/core/projection/phase9.js';
import { PHASE10_RULES } from '../src/core/projection/phase10.js';
import { PHASE7_SERVER_IDS } from '../src/core/projection/phase7.js';

// Projection Phase 11 — the tranche's own rules, offline.
//
// WHAT THIS SUITE IS FOR. The mixed gate needs Docker, a reachable /dev/fuse, a Go toolchain image and a
// filesystem that agrees with itself about which file a descriptor is open on. This runs everywhere in
// milliseconds and pins the things a real run cannot check about itself:
//
//   * that every threshold is IMPORTED from the closed tranche it claims to come from, READ FROM THAT
//     MODULE, so a number cannot be re-derived here and drift from the one the product is built on;
//   * that the three NEW ones are the three the contract names, and every one is zero;
//   * that the fourteen claims are the document's fourteen, in the document's order, and that the two tiers
//     are a partition of them;
//   * THAT A FAKE VERDICT CANNOT CLOSE A TIER-TWO CLAIM — the single property Phase 10 §8.1 authorised this
//     whole tranche on, and the one a green fake run would otherwise quietly acquire;
//   * that a tier-one closure cannot even CARRY a tier-two verdict, so the two cannot be averaged;
//   * that a skip, a duplicate verdict, a short run or a budget a run supplied for itself is not success;
//   * that P11-M6's measurement is a FUNCTION of what a run reached rather than a constant;
//   * that this tranche ships no product source and does not re-open the Phase 8 soak, ASSERTED by running
//     the contract's own decision procedure;
//   * and that the ownership boundary of §2.3 held — no second daemon, no second owner of the mount point.

const h = createHarness('Projection Phase 11 — the tranche rules, offline');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

/**
 * A document with its line wrapping flattened.
 *
 * EVERY PROSE ASSERTION BELOW USES THIS. A pin that searched the raw bytes would pass or fail on where a
 * sentence happened to wrap, which is a property of the editor rather than of the claim — and the first time
 * it broke for that reason somebody would delete the pin instead of the wrap.
 */
const flat = (relative: string): string => read(relative).replace(/\s+/g, ' ');

const CONTRACT = 'docs/PROJECTION_PHASE_11_MIXED_SOURCE_ACCEPTANCE.md';
const PHASE10_CONTRACT = 'docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md';
const COMPOSE = 'docker-compose.projection-phase11.yml';
const GATE = 'deploy/projection-phase11-mixed-gate.sh';
const THREE = 'deploy/projection-phase11-mixed-gate-three.sh';
const OPTIONAL = 'deploy/projection-phase11-mixed-gate-optional.sh';

const okResult = (gate: string): Phase11GateResult => {
  const key = phase11BudgetKeyFor(gate);
  if (key === undefined) return { gate, verdict: 'pass' };
  const budget = PHASE11_RULES[key];
  return { gate, verdict: 'pass', budget, measured: key === 'CONSECUTIVE_FRESH_RUNS' ? budget : 0 };
};
const fullRun = (tier: Phase11Tier): Phase11Results => ({
  tier,
  sequences: [{ index: 1 }, { index: 2 }, { index: 3 }],
  results: (tier === 'one' ? PHASE11_TIER_ONE_GATE_IDS : [...PHASE11_CLOSURE_GATE_IDS]).map(okResult),
});

h.section('the fourteen claims, and the document they come from');

test('the gate ids are the document\'s fourteen claims, numbered in the document\'s own order', () => {
  assertEq(PHASE11_CLOSURE_GATE_IDS.length, 14, 'fourteen claims');
  const contract = read(CONTRACT);
  let cursor = 0;
  for (const id of PHASE11_CLOSURE_GATE_IDS) {
    const number = id.slice(0, id.indexOf('-', 4));
    const at = contract.indexOf(`**${number}**`, cursor);
    assert(at > 0, `${number} is not named in §5, or is out of the document's order`);
    cursor = at;
  }
});

test('the two tiers are a partition of the fourteen, and every id knows which one it is in', () => {
  const union = [...PHASE11_TIER_ONE_GATE_IDS, ...PHASE11_TIER_TWO_GATE_IDS].sort();
  assertEq(union.join(','), [...PHASE11_CLOSURE_GATE_IDS].sort().join(','), 'the tiers are not a partition');
  assertEq(PHASE11_TIER_ONE_GATE_IDS.length, 10, 'ten tier-one claims');
  assertEq(PHASE11_TIER_TWO_GATE_IDS.length, 4, 'four tier-two claims');
  for (const id of PHASE11_CLOSURE_GATE_IDS) {
    assert(phase11TierOf(id) !== undefined, `${id} belongs to no tier`);
  }
  assertEq(phase11TierOf('P11-M99-invented'), undefined, 'an id §5 does not name was placed in a tier');
});

test('the six arms and the four sequence-level claims are a partition of tier one', () => {
  const union = [...PHASE11_ARM_GATE_IDS, ...PHASE11_SEQUENCE_LEVEL_GATE_IDS].sort();
  assertEq(union.join(','), [...PHASE11_TIER_ONE_GATE_IDS].sort().join(','), 'not a partition of tier one');
  assertEq(PHASE11_ARM_GATE_IDS.length, 6, '§5.4 predeclares six arms');
});

test('what a fake run may emit is the six arms and NOTHING else, in either direction', () => {
  assertEq([...PHASE11_FAKE_EMITTABLE_GATE_IDS].sort().join(','), [...PHASE11_ARM_GATE_IDS].sort().join(','),
    'the fake-emittable set is not the six predeclared arms');
  for (const id of PHASE11_TIER_TWO_GATE_IDS) {
    assert(!PHASE11_FAKE_EMITTABLE_GATE_IDS.includes(id),
      `${id} is a tier-two claim and a fake run is allowed to emit it, which is §4's third refusal broken`);
  }
  for (const id of PHASE11_SEQUENCE_LEVEL_GATE_IDS) {
    assert(!PHASE11_FAKE_EMITTABLE_GATE_IDS.includes(id),
      `${id} is a claim about a set of runs and one run is allowed to emit it`);
  }
});

test('every claim has a one-line title, and no title names a path, a URL or an identity', () => {
  for (const id of PHASE11_CLOSURE_GATE_IDS) {
    const title = PHASE11_GATE_TITLES[id];
    assert(typeof title === 'string' && title.length > 0, `${id} has no title`);
    assert(!/https?:\/\/|\/mnt\/|\/var\//.test(title), `${id}'s title names a path or a URL`);
  }
});

h.section('the thresholds');

test('every imported threshold is the value the tranche it came from holds, read from that module', () => {
  assertEq(PHASE11_RULES.CONSECUTIVE_FRESH_RUNS, PHASE10_RULES.CONSECUTIVE_FRESH_RUNS, 'the repetition count');
  assertEq(PHASE11_RULES.OPERATOR_INTERVENTIONS_MAX, PHASE10_RULES.OPERATOR_INTERVENTIONS_MAX, 'interventions');
  assertEq(PHASE11_RULES.RESIDUE_MAX, PHASE10_RULES.RESIDUE_MAX, 'residue');
  assertEq(PHASE11_RULES.HAND_RUN_COMMANDS_MAX, PHASE10_RULES.HAND_RUN_COMMANDS_MAX, 'hand-run commands');
  assertEq(PHASE11_RULES.GENERATION_BYTES_CHANGED_BY_REPORT_MAX,
    PHASE10_RULES.GENERATION_BYTES_CHANGED_BY_REPORT_MAX, 'generation bytes moved by a report');
  assertEq(PHASE11_RULES.ADMISSIONS_WITHOUT_DRIFT_CHECK_MAX,
    PHASE10_RULES.ADMISSIONS_WITHOUT_DRIFT_CHECK_MAX, 'admissions without a drift check');
  assertEq(PHASE11_RULES.MIN_TORBOX_ENTRIES, PHASE9_RULES.MIN_TORBOX_ENTRIES, 'the provider-backed minimum');
  assertEq(PHASE11_RULES.MIN_ADMITTED_USENET_ENTRIES, PHASE9_RULES.MIN_ADMITTED_USENET_ENTRIES,
    'the admitted-Usenet minimum');
  // AND THE THREE REAL SERVER IDS ARE PHASE 7's OWN, so no tier-two report can disagree with an earlier one.
  assertEq([...PHASE11_SERVER_IDS].join(','), [...PHASE7_SERVER_IDS].join(','), 'the three media server ids');
});

test('the three NEW thresholds are the three §5.3 names, and every one of them is ZERO', () => {
  for (const key of ['CROSS_SOURCE_FIELDS_DISTURBED_MAX', 'UNREACHED_ARMS_MAX',
    'TIER_TWO_IDS_EMITTABLE_BY_A_FAKE_RUN'] as const) {
    assertEq(PHASE11_RULES[key], 0, `${key} is not zero, and all three are the whole point`);
    assert(read(CONTRACT).includes(key), `${key} is not in §5.3 of the contract`);
  }
});

test('EXACTLY TWO ARMS CARRY A NUMBER, and they are M4 and M6', () => {
  // §5.3's last paragraph. A third measured arm would be a budget the contract never set, and a run that
  // supplied one would be a run measuring itself against its own opinion.
  const measured = PHASE11_ARM_GATE_IDS.filter((id) => phase11BudgetKeyFor(id) !== undefined);
  assertEq(measured.join(','),
    'P11-M4-one-source-failing-disturbs-nothing-of-the-other,P11-M6-arms-reached-cleanup-and-redaction',
    'the measured arms are not the two §5.1 marks as MEASURED');
  for (const id of PHASE11_CLOSURE_GATE_IDS) {
    const key = phase11BudgetKeyFor(id);
    if (key === undefined) continue;
    assert(key in PHASE11_RULES, `${id} is measured against ${key}, which §5.3 does not name`);
  }
});

h.section('P11-M6 — reached is not passed, and the count is a function');

test('an arm the run never reached is COUNTED, and an arm it invented is counted the other way', () => {
  assertEq(phase11UnreachedArms([...PHASE11_ARM_GATE_IDS]).length, 0, 'a complete run reported an unreached arm');
  const missingOne = PHASE11_ARM_GATE_IDS.filter((id) => id !== PHASE11_ARM_GATE_IDS[3]);
  assertEq(phase11UnreachedArms([...missingOne]).join(','), PHASE11_ARM_GATE_IDS[3],
    'an arm a conditional jumped over was not counted, which is Phase 8 defect #11 wearing this tranche\'s '
    + 'clothes');
  assertEq(phase11UnreachedArms([]).length, 6, 'a run that reached nothing reported nothing unreached');
  // THE OTHER DIRECTION. A run that invented a seventh arm would raise its own denominator.
  assertEq(phase11UndeclaredArms([...PHASE11_ARM_GATE_IDS, 'P11-M7-invented']).join(','), 'P11-M7-invented',
    'an arm the contract never declared was accepted into the accounting');
  assertEq(phase11UndeclaredArms([...PHASE11_ARM_GATE_IDS]).length, 0, 'a complete run invented an arm');
});

test('the six recorded fields are the shipped status surface\'s own, and the locator is refused not forgotten', () => {
  // THE DENOMINATOR OF P11-M3 AND P11-M4, PINNED AGAINST THE PRODUCT RATHER THAN AGAINST A COMMENT. A field
  // added to `ContentStatusEntry` that this list did not learn about would be a field the cross-source
  // measurement silently stopped comparing, which is the quietest way for a budget of zero to become easier
  // to meet.
  const shipped = read('src/ops/projection-content.ts');
  const block = shipped.slice(shipped.indexOf('export interface ContentStatusEntry {'));
  const declared = [...block.slice(0, block.indexOf('\n}\n')).matchAll(/^\s*readonly ([A-Za-z]+)[?:]/gm)]
    .map((match) => match[1] as string);
  assertEq([...declared].sort().join(','), [...PHASE11_RECORDED_ENTRY_FIELDS].sort().join(','),
    'the shipped status entry carries a different field set than the one P11-M4 measures over');
  // AND THE LOCATOR IS NOT ONE OF THEM, WHICH IS §4's NINTH REFUSAL RATHER THAN AN OVERSIGHT.
  assert(!PHASE11_RECORDED_ENTRY_FIELDS.includes('locator') && !PHASE11_RECORDED_ENTRY_FIELDS.includes('sources'),
    'a provider object reference is in the field set, so P11-M4 would put one in its own evidence and P11-M6 '
    + 'asserts no preserved file carries one');
  assert(/re-read the other half \*\*through the mount\*\*/.test(flat(CONTRACT).replace(/\s+/g, ' ')),
    '§5.1 no longer says what covers a moved locator instead');
});

test('a generation holding one kind is NOT a mixed generation', () => {
  assertEq(phase11MixedGenerationProblems({ httpRange: 1, local: 1 }).length, 0, 'a mixed generation was refused');
  assert(phase11MixedGenerationProblems({ httpRange: 2, local: 0 }).some((one) => /worker-produced/.test(one)),
    'two provider-backed entries and no local one read as a mixed generation');
  assert(phase11MixedGenerationProblems({ httpRange: 0, local: 2 }).some((one) => /provider-backed/.test(one)),
    'two local entries and no provider-backed one read as a mixed generation');
});

h.section('closure — the refusal Phase 10 §8.1 authorised this tranche on');

test('a complete, honest run closes in either tier', () => {
  assertEq(phase11ClosureProblems(fullRun('one')).join(' | '), '', 'a complete tier-one run reported a problem');
  assertEq(phase11Closed(fullRun('one')), true, 'a complete tier-one run did not close');
  assertEq(phase11ClosureProblems(fullRun('two')).join(' | '), '', 'a complete tier-two run reported a problem');
});

test('A FAKE VERDICT CANNOT CLOSE A TIER-TWO CLAIM, and CAN close every arm', () => {
  for (const id of PHASE11_TIER_TWO_GATE_IDS) {
    const results = fullRun('two');
    const problems = phase11ClosureProblems({
      ...results,
      results: results.results.map((one) => (one.gate === id ? { ...one, fake: true } : one)),
    });
    assert(problems.some((problem) => problem.includes(id) && /fake mode/.test(problem)),
      `${id} closed on a fake run, and §5.2 asks it of real operator inputs and three real media servers`);
  }
  for (const id of PHASE11_ARM_GATE_IDS) {
    const results = fullRun('one');
    const problems = phase11ClosureProblems({
      ...results,
      results: results.results.map((one) => (one.gate === id ? { ...one, fake: true } : one)),
    });
    assertEq(problems.join(' | '), '', `${id} could not be answered by the gate that exists to answer it`);
  }
});

test('a fake verdict cannot close a claim about a SET of runs either', () => {
  for (const id of PHASE11_SEQUENCE_LEVEL_GATE_IDS) {
    const results = fullRun('one');
    const problems = phase11ClosureProblems({
      ...results,
      results: results.results.map((one) => (one.gate === id ? { ...one, fake: true } : one)),
    });
    assert(problems.some((problem) => problem.includes(id) && /set of runs/.test(problem)),
      `${id} closed on one gate run, and it is a claim about a set of runs this one is not a member of`);
  }
});

test('a TIER-ONE closure may not even CARRY a tier-two verdict, so the two cannot be averaged', () => {
  const results = fullRun('one');
  const problems = phase11ClosureProblems({
    ...results,
    results: [...results.results, { gate: PHASE11_TIER_TWO_GATE_IDS[0], verdict: 'pass' }],
  });
  assert(problems.some((problem) => /closes nothing about the mixed product/.test(problem)),
    'a tier-one closure carried a tier-two verdict, which is exactly the evidence a reader averages');
});

test('a tier-two closure needs the tier-two claims, and a skipped one says what it is waiting for', () => {
  const missing = fullRun('two');
  const withoutTierTwo = phase11ClosureProblems({
    ...missing,
    results: missing.results.filter((one) => phase11TierOf(one.gate) === 'one'),
  });
  assert(withoutTierTwo.some((problem) => /has no verdict/.test(problem)),
    'a tier-two closure was granted on tier-one evidence alone');

  const skipped = phase11ClosureProblems({
    ...missing,
    results: missing.results.map((one) =>
      (one.gate === PHASE11_TIER_TWO_GATE_IDS[1] ? { gate: one.gate, verdict: 'skip' as const } : one)),
  });
  assert(skipped.some((problem) => /three real pre-attached media servers/.test(problem)),
    'a skipped tier-two claim did not say which operator inputs it was waiting for');
});

test('a short run, a missing verdict and a duplicated verdict are each refused', () => {
  const short = phase11ClosureProblems({ ...fullRun('one'), sequences: [{ index: 1 }] });
  assert(short.some((problem) => /fresh sequences/.test(problem)), 'a one-sequence run closed');

  const gapped = phase11ClosureProblems({ ...fullRun('one'), sequences: [{ index: 1 }, { index: 3 }, { index: 4 }] });
  assert(gapped.some((problem) => /numbered from one/.test(problem)), 'a gapped sequence numbering closed');

  const complete = fullRun('one');
  const withoutOne = phase11ClosureProblems({ ...complete, results: complete.results.slice(1) });
  assert(withoutOne.some((problem) => /has no verdict/.test(problem)), 'an absent verdict read as a pass');

  const twice = phase11ClosureProblems({
    ...complete, results: [...complete.results, okResult(PHASE11_ARM_GATE_IDS[0])],
  });
  assert(twice.some((problem) => /more than one verdict/.test(problem)), 'a duplicated verdict read as confirmation');
});

test('a run cannot supply its own budget, nor pass while exceeding the contract\'s', () => {
  const target = 'P11-M4-one-source-failing-disturbs-nothing-of-the-other';
  const complete = fullRun('one');
  const wrongBudget = phase11ClosureProblems({
    ...complete,
    results: complete.results.map((one) => (one.gate === target ? { ...one, budget: 99 } : one)),
  });
  assert(wrongBudget.some((problem) => /rather than against the/.test(problem)), 'a run supplied its own budget');

  const overBudget = phase11ClosureProblems({
    ...complete,
    results: complete.results.map((one) => (one.gate === target ? { ...one, measured: 1 } : one)),
  });
  assert(overBudget.some((problem) => /while reporting 1/.test(problem)),
    'one field of the other source moved and the claim passed against a budget of zero');

  const unmeasured = phase11ClosureProblems({
    ...complete,
    results: complete.results.map((one) => (one.gate === target ? { gate: one.gate, verdict: 'pass' as const,
      budget: PHASE11_RULES.CROSS_SOURCE_FIELDS_DISTURBED_MAX } : one)),
  });
  assert(unmeasured.some((problem) => /without recording what it measured/.test(problem)),
    'a measured arm passed without recording a number');

  // AND THE FLOOR IS A FLOOR. Two fresh runs are not three, whichever direction the comparison is written in.
  const shortSequences = phase11ClosureProblems({
    ...complete,
    results: complete.results.map((one) =>
      (one.gate === 'P11-S2-mixed-gate-three-fresh' ? { ...one, measured: 2 } : one)),
  });
  assert(shortSequences.some((problem) => /while reporting 2/.test(problem)), 'two fresh runs passed as three');
});

test('a claim with no budget cannot report a measurement it invented, and an unnamed id is refused', () => {
  const complete = fullRun('one');
  const invented = phase11ClosureProblems({
    ...complete,
    results: complete.results.map((one) =>
      (one.gate === PHASE11_ARM_GATE_IDS[0] ? { ...one, measured: 0, budget: 0 } : one)),
  });
  assert(invented.some((problem) => /a budget §5.3 does not give it/.test(problem)),
    'a pass/fail arm reported a measurement against a budget the contract never set');

  const unnamed = phase11ClosureProblems({
    ...complete, results: [...complete.results, { gate: 'P11-M99-invented', verdict: 'pass' }],
  });
  assert(unnamed.some((problem) => /which §5 does not name/.test(problem)), 'an invented id was accepted');
});

h.section('§4 — the refusals that are checkable');

test('this tranche does NOT re-open the Phase 8 soak, asserted by running the contract\'s own function', () => {
  assertEq(phase9RequiresSoakRerun(PHASE11_TRANCHE_PATHS), false,
    'a path this tranche touches is on PHASE9_SOAK_TRIGGERING_SOURCE, which re-opens three consecutive soaks '
    + 'plus Phase 7\'s whole sequence against a rotating CDN pool');
});

test('THIS TRANCHE SHIPS NO PRODUCT SOURCE, which §3.1 and §6.2 both say and this is where it is checked', () => {
  // §6.2: the only two files outside §6.1's own-new list that this tranche may modify are the two wiring
  // files. A tranche that shipped a module under `src/` other than its own rules module would be a tranche
  // whose changes are on somebody else's regression surface.
  for (const path of PHASE11_TRANCHE_PATHS) {
    if (!path.startsWith('src/')) continue;
    assertEq(path, 'src/core/projection/phase11.ts',
      `${path} is product source and §3.1 says this tranche ships none`);
  }
  // AND THE FILES IT TOUCHES THAT ARE NOT ITS OWN ARE EXACTLY §6.2's, LISTED RATHER THAN FILTERED. An
  // earlier form of this assertion excluded everything under `test/` before comparing, which passed
  // vacuously the moment this tranche widened five TorBox allowlists — a test that reads like a boundary and
  // checks nothing is worse than no test, because somebody has already stopped looking at the boundary.
  const own = new Set([
    'docs/PROJECTION_PHASE_11_MIXED_SOURCE_ACCEPTANCE.md',
    'src/core/projection/phase11.ts',
    'deploy/projection-phase11-mixed-gate.sh',
    'deploy/projection-phase11-mixed-gate-three.sh',
    'deploy/projection-phase11-mixed-gate-optional.sh',
    COMPOSE,
    'test/projection-phase11.ts',
    'test/projection-phase11-gate-audit.ts',
  ]);
  const foreign = PHASE11_TRANCHE_PATHS.filter((path) => !own.has(path));
  assertEq([...foreign].sort().join('\n'), [
    'package.json',
    'test/suite-inventory.json',
    'test/torbox-boundary.ts',
    'test/torbox-fake-adapter.ts',
    'test/torbox-live-smoke-cli.ts',
    'test/torbox-live-transport.ts',
    'test/torbox-provider-adapter.ts',
    'test/torbox-readonly-client.ts',
    'test/torbox-real-client-gate.ts',
    'test/torbox-transport-acceptance.ts',
  ].join('\n'), 'this tranche touches a file outside its own set that §6.2 does not list');
});

test('every widened TorBox allowlist names this tranche\'s module AND carries a reason beside it', () => {
  // §6.2 AND PHASE 10 §7 R4: widening an allowlist is where a provider boundary gets quietly weakened, and
  // the allowlist's own comment says the reason written beside the addition is what makes it legitimate. An
  // entry with no reason is the shape of change that guard exists to catch.
  const widened = PHASE11_TRANCHE_PATHS.filter((path) => path.startsWith('test/torbox-'));
  assertEq(widened.length, 8, 'the widened allowlist set has changed size');
  for (const relative of widened) {
    const body = read(relative);
    const at = body.indexOf(`'src/core/projection/phase11.ts',`);
    assert(at > 0, `${relative} does not list this tranche's module, so the widening is not where it claims`);
    const before = body.slice(Math.max(0, at - 900), at);
    assert(/PHASE 11 JOINS THE LIST, WITH ITS REASON/.test(before),
      `${relative} lists this tranche's module with no reason beside it, and an un-reasoned addition is `
      + 'exactly what these eight suites exist to refuse');
    assert(/MIN_TORBOX_ENTRIES/.test(before) && /CONTACTS NOTHING/.test(before),
      `${relative}'s reason does not say WHY the naming is unavoidable or WHAT the module does not do`);
  }
});

test('every path the tranche claims to touch exists, so the list cannot go quietly stale', () => {
  for (const path of PHASE11_TRANCHE_PATHS) {
    assert(existsSync(join(repoRoot, path)), `${path} is on the tranche's own path list and is not in the tree`);
  }
});

test('the forbidden source is still there and is not on the tranche\'s own list', () => {
  for (const path of PHASE11_FORBIDDEN_SOURCE) {
    assert(existsSync(join(repoRoot, path)), `${path} is forbidden to modify and has gone missing`);
    assert(!PHASE11_TRANCHE_PATHS.includes(path), `${path} is both forbidden and claimed as touched`);
  }
  // PHASE 10's OWN MODULE AND SCRIPT ARE ON THAT LIST, and that is §4's eighth refusal: this tranche IMPORTS
  // Phase 10's thresholds and does not re-derive them, so it has no business editing where they live.
  assert(PHASE11_FORBIDDEN_SOURCE.includes('src/core/projection/phase10.ts'), 'Phase 10 rules are not protected');
  assert(PHASE11_FORBIDDEN_SOURCE.includes('deploy/projection-content.sh'), 'the content plane is not protected');
});

test('NO SECOND DAEMON AND NO SECOND OWNER OF THE MOUNT POINT — §4\'s fourth refusal, over the shipped bytes', () => {
  const code = read(GATE).replace(/^\s*#.*$/gm, '');
  for (const forbidden of [/\bmount\s+--bind\b/, /\bfusermount\b/, /\bumount\b/, /^\s*mount\s/m]) {
    assert(!forbidden.test(code),
      `the gate performs its own mount operation, and Phase 8 §13 gives the mount point exactly one owner`);
  }
  // IT DRIVES THE SHIPPED SCRIPT INSTEAD, and this is what says so rather than the comment above it.
  assert(/projection-alpha\.sh/.test(read(GATE)), 'the gate does not drive the shipped appliance script');
  assert(/projection-content\.sh/.test(read(GATE)), 'the gate does not drive the shipped content script');
  // AND THE COMPOSE FILE HAS EXACTLY ONE SERVICE, which is the same refusal one layer down. The block is
  // sliced from `services:` to the next TOP-LEVEL key rather than counting two-space keys across the whole
  // file — `networks:` has a two-space child of its own, and a model that counted it would report two
  // services in a file that declares one, which is the false failure that gets a pin deleted.
  const compose = read(COMPOSE).replace(/^\s*#.*$/gm, '');
  const servicesAt = compose.indexOf('\nservices:\n');
  assert(servicesAt >= 0, 'the Phase 11 compose file declares no services block');
  const afterServices = compose.slice(servicesAt + '\nservices:\n'.length);
  const nextTopLevel = /^[a-z][a-z0-9-]*:/m.exec(afterServices)?.index ?? afterServices.length;
  const servicesBlock = afterServices.slice(0, nextTopLevel);
  assertEq((servicesBlock.match(/^ {2}[a-z][a-z0-9-]*:$/gm) ?? []).length, 1,
    'the Phase 11 compose file declares more than one service, and a daemon written into it would be a '
    + 'second owner of the mount point');
  assert(!/projectiond|plex|jellyfin|emby|sabnzbd/i.test(compose),
    'the compose file names a daemon, a worker or a media server');
});

test('the four Phase 9 claims are named as untouchable, and no Phase 11 file records a P9- or P10- verdict', () => {
  assertEq(PHASE11_UNTOUCHABLE_PHASE9_CLAIMS.length, 4, 'four open Phase 9 claims');
  for (const relative of ['src/core/projection/phase11.ts', GATE, THREE, OPTIONAL]) {
    const body = read(relative);
    assert(!/VERDICT\s+P9-|verdict\(\s*['"]P9-|VERDICT\s+P10-/.test(body),
      `${relative} records an earlier tranche's verdict, and that tranche's own document is the only place `
      + 'one may be written');
  }
});

test('the contract inherits the Phase 9 prerequisite rather than discharging it', () => {
  const contract = flat(CONTRACT);
  assert(/does not discharge that prerequisite/i.test(contract), '§2.4 does not inherit the prerequisite');
  assert(/exactly as open/i.test(contract), '§8 does not say the Phase 9 claims are exactly as open');
  for (const claim of ['P9-2', 'P9-3', 'P9-5', 'P9-11']) {
    assert(contract.includes(claim), `§4's second refusal does not name ${claim}`);
  }
});

test('the tier-one ceiling sentence is Phase 10 §8.1\'s, and BOTH documents still carry it', () => {
  assert(flat(PHASE10_CONTRACT).includes(PHASE11_TIER_ONE_CEILING_SENTENCE),
    'Phase 10 §8.1 no longer carries the sentence this tranche is bounded by');
  assert(flat(CONTRACT).includes(PHASE11_TIER_ONE_CEILING_SENTENCE),
    '§8 no longer carries the sentence a roadmap row may not exceed');
  assert(flat(CONTRACT).includes('It closes nothing about the mixed product'),
    '§8 no longer says a tier-one GO closes nothing about the mixed product');
});

test('the contract still states every non-claim, so a summary cannot grow one', () => {
  const contract = flat(CONTRACT).toLowerCase();
  for (const nonclaim of PHASE11_NONCLAIMS) {
    assert(contract.includes(nonclaim.toLowerCase()), `§8 no longer says this tranche is not ${nonclaim}`);
  }
});

test('every tier-two operator input is something only an operator has, and §9.2 lists it', () => {
  assert(PHASE11_TIER_TWO_OPERATOR_INPUTS.length >= 5, 'the operator input list has been shortened');
  const contract = flat(CONTRACT);
  for (const fragment of ['TorBox credentials', 'NNTP provider already configured', 'Plex, Jellyfin and Emby']) {
    assert(contract.includes(fragment), `§9.2 no longer names ${fragment}`);
  }
});

h.section('the compose file, and both of its ports');

test('the gate ports collide with no other compose file and no other deploy script', () => {
  const compose = read(COMPOSE);
  const match = /:-(\d{4})\}:5432/.exec(compose);
  assert(match !== null, 'the compose file publishes no recognisable PostgreSQL port');
  assertEq(Number(match[1]), PHASE11_GATE_PG_PORT, 'the Phase 11 database port');
  assert(compose.includes('name: projection-phase11-gate'), 'the compose project is not its own');

  for (const entry of readdirSync(repoRoot)) {
    if (!entry.startsWith('docker-compose.') || entry === COMPOSE) continue;
    const other = read(entry);
    assert(!other.includes(`${PHASE11_GATE_PG_PORT}:5432`) && !other.includes(`:-${PHASE11_GATE_PG_PORT}}`),
      `${entry} already binds ${PHASE11_GATE_PG_PORT}, so two gates could lend each other state`);
  }
  // THE FAKE ORIGIN'S PORT IS CHECKED AGAINST THE SCRIPTS AS WELL, because a fake provider is not a database
  // and no compose file would ever have mentioned it. `8130` is the real-provider gate's; this is not it.
  assert(read(GATE).includes(String(PHASE11_FAKE_ORIGIN_PORT)), 'the gate does not use the declared origin port');
  for (const entry of readdirSync(join(repoRoot, 'deploy'))) {
    if (!entry.endsWith('.sh') || entry.startsWith('projection-phase11-')) continue;
    assert(!read(join('deploy', entry)).includes(`:${PHASE11_FAKE_ORIGIN_PORT}:`),
      `deploy/${entry} already publishes ${PHASE11_FAKE_ORIGIN_PORT}, so two fake origins could collide`);
  }
});

test('PHASE 12: the throwaway database is published on LOOPBACK and not on every interface', () => {
  // THE DEFECT, AND IT ONLY MATTERS BECAUSE OF WHERE §9.1 SAYS THIS RUNS. The compose header says these gates
  // "bind a fixed loopback port"; the mapping said `5680:5432`, which publishes `postgres`/`postgres` on
  // EVERY interface of the host for the life of the run — and the host §9.1 names is the operator's own
  // Unraid box on their LAN. The gate has always reached the database at `127.0.0.1`, so the narrowing costs
  // the run nothing and the comment stops being a description of something that was not true.
  const compose = read(COMPOSE);
  assert(/- "127\.0\.0\.1:\$\{PROJECTION_PHASE11_GATE_PG_PORT:-\d{4}\}:5432"/.test(compose),
    'the Phase 11 gate database is published on every interface of whatever host runs it');
  assert(/127\.0\.0\.1:\$\{PG_PORT\}\/catalog/.test(read(GATE)),
    'the gate no longer reaches its database on loopback, so the binding above would break it');
});

test('PHASE 12 §11 D8: the appliance configuration carries a statusAddr, and it is this gate\'s own port', () => {
  // THE DEFECT, FOUND BY THE FIRST RUN THAT EVER REACHED AN ARM. `projection-alpha.sh preflight` counts a
  // configuration with no usable `statusAddr` as a FAILED CHECK — "status and the healthcheck cannot work" —
  // so preflight, install and start all refused, the appliance never came up, no mount ever existed, and
  // P11-M2, P11-M3 and P11-M4 failed on reads of a namespace that was never there. The refusal is the shipped
  // script being right; the gate handed it a configuration no operator would write.
  const body = read(GATE);
  const from = body.indexOf("cat > \"$WORK/config.json\" <<'DAEMONJSON'");
  const to = body.indexOf('\nDAEMONJSON\n', from);
  assert(from > 0 && to > from, 'the appliance configuration heredoc could not be located');
  const config = JSON.parse(body.slice(body.indexOf('{', from), to)) as { statusAddr?: string };
  assert(typeof config.statusAddr === 'string' && /^127\.0\.0\.1:\d{4}$/.test(config.statusAddr),
    'the appliance configuration names no loopback statusAddr, and the shipped preflight refuses without one');
  // AND THE PORT IS THIS GATE'S OWN. Two appliances answering on one status port would be two gates lending
  // each other a healthcheck, which is the same argument the database and origin ports are cross-checked on.
  const port = (config.statusAddr as string).split(':')[1] as string;
  for (const entry of readdirSync(join(repoRoot, 'deploy'))) {
    if (!entry.endsWith('.sh') || entry.startsWith('projection-phase11-')) continue;
    assert(!read(join('deploy', entry)).includes(`127.0.0.1:${port}`),
      `deploy/${entry} already uses status port ${port}, so two appliances could answer on one`);
  }
  for (const entry of readdirSync(repoRoot)) {
    if (!entry.startsWith('docker-compose.')) continue;
    assert(!read(entry).includes(`127.0.0.1:${port}`), `${entry} already binds ${port}`);
  }
});

test('PHASE 12: every wait in the gate is BOUNDED, including the one Compose does not bound itself', () => {
  // `docker compose up --wait` HAS NO TIMEOUT OF ITS OWN. A database that never reports healthy — an image
  // that will not pull, a port already held, a host under load — left this command waiting with no output and
  // nothing to read, on a gate whose every other wait is bounded by an attempt count.
  const code = read(GATE).replace(/^\s*#.*$/gm, '');
  assert(/--wait --wait-timeout "\$PG_WAIT_SECONDS"/.test(code),
    'the database wait is unbounded, so a host that cannot start it hangs the run instead of failing it');
  assert(/PG_WAIT_SECONDS="\$\{PROJECTION_PHASE11_PG_WAIT_SECONDS:-\d+\}"/.test(code),
    'the bound is not an overridable named value, so a slow host has no way past it but a code edit');
  // AND THE TWO LOOPS THAT WERE ALREADY BOUNDED STAY BOUNDED, because a bound removed from one of them would
  // be the same defect wearing a different hat.
  assert(/for attempt in 1 2 3/.test(code), 'the origin readiness and quiescence loops are no longer bounded');
});

test('the database is throwaway, and the compose file names no provider', () => {
  const compose = read(COMPOSE);
  assert(/tmpfs/.test(compose) && /\/var\/lib\/postgresql\/data/.test(compose),
    'the gate database survives its container, so three fresh runs would not be fresh');
  const body = compose.replace(/^#.*$/gm, '');
  assert(!/torbox|nntp|endpoint\.json/i.test(body), 'the compose file names a provider');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase11.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase11.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

test('every Phase 11 script is reachable from a named npm script', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  for (const name of ['go:phase11-mixed-gate', 'go:phase11-mixed-gate:three', 'go:phase11-mixed-gate:optional',
    'test:phase11']) {
    assert(name in scripts, `${name} is not an npm script, so nobody can run it the documented way`);
  }
});

await h.finish();
