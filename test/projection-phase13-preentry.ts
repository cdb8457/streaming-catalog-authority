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
  PHASE13_PREENTRY_CAMPAIGN_GATE_IDS,
  PHASE13_PREENTRY_CEILING_SENTENCE,
  PHASE13_PREENTRY_CLOSURE_GATE_IDS,
  PHASE13_PREENTRY_FORBIDDEN_EMITTABLE_IDS,
  PHASE13_PREENTRY_FORBIDDEN_SOURCE,
  PHASE13_PREENTRY_GATE_TITLES,
  PHASE13_PREENTRY_INSTRUMENT_GATE_IDS,
  PHASE13_PREENTRY_MEANING,
  PHASE13_PREENTRY_NONCLAIMS,
  PHASE13_PREENTRY_OWNERSHIP_SECTION,
  PHASE13_PREENTRY_DISPOSITIONS,
  PHASE13_PREENTRY_PRESERVED_STATES,
  PHASE13_PREENTRY_READINESS_FINDINGS,
  PHASE13_PREENTRY_RULES,
  PHASE13_PREENTRY_TRANCHE_PATHS,
  originRotationDisposition,
  originStabilityRefusals,
  phase13PreEntryBudgetKeyFor,
  phase13PreEntryClosed,
  phase13PreEntryClosureProblems,
  phase13PreEntrySkippedClaims,
  type Phase13PreEntryGateResult,
} from '../src/core/projection/phase13-preentry.js';

// Projection Phase 13 PRE-ENTRY — the tranche's own rules, offline.
//
// WHAT THIS SUITE IS FOR. The four questions every tranche's own suite asks — that the claim ids are the
// document's in the document's order, that a skip cannot become a pass, that a run cannot supply its own
// budget, and that the boundary this tranche drew around itself held — plus the two this tranche has that no
// earlier one did.
//
// THE FIRST IS THE NAMESPACE. Phase 13's ids are `P13-A*` and `P13-S*` and this tranche does not enter Phase
// 13, so a pre-entry record that could write one would be a pre-entry record that had entered. That is
// checked as a refusal in the closure function rather than as a naming convention nobody enforces.
//
// THE SECOND IS THAT `P11-R1` HAS NO HALF. The Phase 12 roadmap row says Phase 13 may close "the provider
// half only of P11-R1"; the claim is a conjunction about co-residency in one published generation, so there
// is no half to close. §8 of this tranche's document supersedes the sentence, and the check below is that
// the id is structurally unwritable here — by id AND by prefix, so a re-spelling does not get through.
//
// IT STARTS NOTHING, READS NO ENVIRONMENT, AND CONTACTS NOTHING. It reads this repository's own files.

const h = createHarness('Projection Phase 13 pre-entry — the instrument repair rules');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');
const flat = (relative: string): string => read(relative).replace(/\s+/g, ' ');
/** The document as prose: blockquote and list markers removed, so a wrapped quotation compares whole. */
const prose = (relative: string): string => read(relative).replace(/^\s*[>*-]\s?/gm, '').replace(/\s+/g, ' ');

const CONTRACT = 'docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md';
const MODULE = 'src/core/projection/phase13-preentry.ts';

/** A complete, honest record: twelve passes, every budget the contract's own. */
function honestRun(): { results: Phase13PreEntryGateResult[] } {
  return {
    results: PHASE13_PREENTRY_CLOSURE_GATE_IDS.map((gate): Phase13PreEntryGateResult => {
      const key = phase13PreEntryBudgetKeyFor(gate);
      if (key === undefined) return { gate, verdict: 'pass' };
      const budget = PHASE13_PREENTRY_RULES[key];
      return { gate, verdict: 'pass', measured: budget, budget };
    }),
  };
}

h.section('the claims are the document\'s, in the document\'s order');

test('every §5 id appears in the contract, in the order the module lists them', () => {
  const document = read(CONTRACT);
  let cursor = -1;
  for (const gate of PHASE13_PREENTRY_CLOSURE_GATE_IDS) {
    const at = document.indexOf(gate);
    assert(at >= 0, `${gate} is not named in ${CONTRACT}, so the module and the prose are about different things`);
    assert(at > cursor, `${gate} appears out of the module's order in ${CONTRACT}`);
    cursor = at;
  }
});

test('the two tiers partition the closure list with nothing lost and nothing counted twice', () => {
  assertEq(
    PHASE13_PREENTRY_INSTRUMENT_GATE_IDS.length + PHASE13_PREENTRY_CAMPAIGN_GATE_IDS.length,
    PHASE13_PREENTRY_CLOSURE_GATE_IDS.length,
    'the tiers do not add up to the closure list',
  );
  assertEq(new Set(PHASE13_PREENTRY_CLOSURE_GATE_IDS).size, PHASE13_PREENTRY_CLOSURE_GATE_IDS.length,
    'a claim id appears twice');
});

test('every claim has a title, and every title belongs to a claim', () => {
  const titled = Object.keys(PHASE13_PREENTRY_GATE_TITLES);
  assertEq(titled.length, PHASE13_PREENTRY_CLOSURE_GATE_IDS.length, 'the titles and the ids disagree in size');
  for (const gate of PHASE13_PREENTRY_CLOSURE_GATE_IDS) {
    assert(titled.includes(gate), `${gate} has no title`);
  }
});

test('every id is in the pre-entry namespace and none is in Phase 13\'s', () => {
  for (const gate of PHASE13_PREENTRY_CLOSURE_GATE_IDS) {
    assert(gate.startsWith('P13PRE-'), `${gate} is not in the pre-entry namespace`);
    assert(!/^P13-[AS]/.test(gate), `${gate} occupies a real Phase 13 id, which this tranche does not enter`);
  }
});

h.section('the prose and the closure function agree');

test('every threshold in the module is named in §5.3 with its value', () => {
  const document = flat(CONTRACT);
  for (const [name, value] of Object.entries(PHASE13_PREENTRY_RULES)) {
    assert(document.includes(name), `${name} is not named in ${CONTRACT}`);
    assert(new RegExp(`${name}[^|]*\\|[^|]*\\*?\\*?${value}\\*?\\*?`).test(document)
      || document.includes(`${name}\` | **${value}**`) || document.includes(`${name}\` | ${value}`),
      `${name}'s value ${value} is not the one §5.3 states`);
  }
});

test('the two imported thresholds are READ from Phase 12 rather than re-stated here', () => {
  // A COPIED NUMBER IS A NUMBER THAT CAN DRIFT IN THE PASSING DIRECTION. These must be identities.
  assertEq(PHASE13_PREENTRY_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX, PHASE12_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX,
    'REPAIRS_WITHOUT_A_CONTROL_MAX has drifted from Phase 12\'s');
  assertEq(PHASE13_PREENTRY_RULES.SKIPPED_CLAIMS_MAX, PHASE12_RULES.SKIPPED_CLAIMS_MAX,
    'SKIPPED_CLAIMS_MAX has drifted from Phase 12\'s');
  assert(/PHASE12_RULES\.REPAIRS_WITHOUT_A_CONTROL_MAX/.test(read(MODULE))
    && /PHASE12_RULES\.SKIPPED_CLAIMS_MAX/.test(read(MODULE)),
    'the imported thresholds are written as literals rather than read from the module they came from');
});

test('no threshold is a floor, because this tranche counts no sequences', () => {
  for (const value of Object.values(PHASE13_PREENTRY_RULES)) assertEq(value, 0, 'a threshold is not a ceiling of zero');
  assert(!/CONSECUTIVE_FRESH_RUNS/.test(read(MODULE).replace(/^\s*(\/\/|\*).*$/gm, '')),
    'the module imports a fresh-run floor it never measures');
});

h.section('a skip is never a pass, and a run cannot supply its own budget');

test('an honest record closes', () => {
  assertEq(phase13PreEntryClosureProblems(honestRun()).length, 0, 'an honest record did not close');
  assertEq(phase13PreEntryClosed(honestRun()), true, 'an honest record is not closed');
});

test('a SKIP is refused, named, and counted', () => {
  const run = honestRun();
  run.results[0] = { gate: PHASE13_PREENTRY_CLOSURE_GATE_IDS[0], verdict: 'skip' };
  const problems = phase13PreEntryClosureProblems(run);
  assert(problems.some((one) => one.includes('skipped')), 'a skipped claim was not refused');
  assertEq(phase13PreEntrySkippedClaims(run).length, 1, 'the skip was not counted');
  assertEq(phase13PreEntryClosed(run), false, 'a record with a skip closed');
});

test('an ABSENT verdict is not a pass', () => {
  const run = honestRun();
  const dropped = run.results.pop();
  assert(dropped !== undefined, 'nothing was dropped, so this check proves nothing');
  assert(phase13PreEntryClosureProblems(run).some((one) => one.includes('has no verdict')),
    'an absent verdict was accepted');
});

test('a DUPLICATE verdict is not a confirmation', () => {
  const run = honestRun();
  const first = run.results[0];
  assert(first !== undefined, 'the honest record is empty, so this check proves nothing');
  run.results.push({ ...first });
  assert(phase13PreEntryClosureProblems(run).some((one) => one.includes('more than one verdict')),
    'a duplicated verdict was accepted');
});

test('a claim measured against its own budget rather than the contract\'s is refused', () => {
  const run = honestRun();
  const gate = 'P13PRE-I1-every-optional-wrapper-invokes-the-gate-it-names';
  run.results = run.results.map((one) => (one.gate === gate ? { ...one, measured: 4, budget: 4 } : one));
  assert(phase13PreEntryClosureProblems(run).some((one) => one.includes('rather than against the')),
    'a run supplied its own budget and was believed');
});

test('a claim that passed while exceeding the contract\'s budget is refused', () => {
  const run = honestRun();
  const gate = 'P13PRE-I4-every-compose-and-provider-wait-is-bounded';
  run.results = run.results.map((one) => (one.gate === gate ? { ...one, measured: 2 } : one));
  assert(phase13PreEntryClosureProblems(run).some((one) => one.includes('while reporting 2')),
    'a claim passed over its budget');
});

test('a claim with no budget that reports a measurement has invented one', () => {
  const run = honestRun();
  const gate = 'P13PRE-I8-a-skip-is-never-folded-into-success';
  assertEq(phase13PreEntryBudgetKeyFor(gate), undefined, 'this claim was given a budget');
  run.results = run.results.map((one) => (one.gate === gate ? { ...one, measured: 0, budget: 0 } : one));
  assert(phase13PreEntryClosureProblems(run).some((one) => one.includes('does not give it')),
    'a claim invented a budget');
});

h.section('no earlier tranche\'s claim, and no Phase 13 claim, can be written here');

test('each of the eight untouchable ids is refused BY ID', () => {
  for (const forbidden of PHASE13_PREENTRY_FORBIDDEN_EMITTABLE_IDS) {
    const run = honestRun();
    run.results.push({ gate: forbidden, verdict: 'pass' });
    assert(phase13PreEntryClosureProblems(run).some((one) => one.includes('belongs to another tranche')),
      `${forbidden} was accepted as a verdict this tranche may write`);
  }
});

test('P11-R1 has NO HALF, however it is spelled', () => {
  // THE POINT OF THE PREFIX REFUSAL. A record that could not write `P11-R1-…` verbatim but could write
  // `P11-R1-provider-half` would be a record that had invented the half §8 supersedes.
  for (const spelling of [
    'P11-R1-real-mixed-generation-on-the-appliance',
    'P11-R1-provider-half',
    'P11-R1',
    'P11-R1-partial',
  ]) {
    const run = honestRun();
    run.results.push({ gate: spelling, verdict: 'pass' });
    const problems = phase13PreEntryClosureProblems(run);
    assert(problems.some((one) => one.includes('no provider half of P11-R1 to close')),
      `${spelling} was not refused, so a provider half of P11-R1 is expressible here`);
  }
});

test('a real Phase 13 id cannot carry a verdict here, because this tranche does not enter Phase 13', () => {
  for (const spelling of ['P13-A1-operator-corpus-preflighted', 'P13-S1-three-consecutive-fresh-real-runs']) {
    const run = honestRun();
    run.results.push({ gate: spelling, verdict: 'pass' });
    assert(phase13PreEntryClosureProblems(run).some((one) => one.includes('belongs to another tranche')),
      `${spelling} was accepted, so a pre-entry record can spend Phase 13's namespace`);
  }
});

test('an id §5 does not name is refused even when it is in this namespace', () => {
  const run = honestRun();
  run.results.push({ gate: 'P13PRE-I99-something-nobody-agreed-to', verdict: 'pass' });
  assert(phase13PreEntryClosureProblems(run).some((one) => one.includes('which §5 does not name')),
    'an unnamed claim was accepted');
});

h.section('the origin policy for a rotating pool');

test('a sequence that fits inside the shortest observed turn, with margin, may start', () => {
  assertEq(originStabilityRefusals({
    shortestObservedOriginLifetimeMinutes: 40,
    boundedSequenceDurationMinutes: 25,
    originRecordAgeMinutes: 5,
    allowedOriginCount: 7,
    observedPoolSize: 7,
  }).length, 0, 'a fitting sequence was refused');
});

test('a sequence that does not fit is REFUSED before it starts', () => {
  const refusals = originStabilityRefusals({
    shortestObservedOriginLifetimeMinutes: 40,
    boundedSequenceDurationMinutes: 35,
    originRecordAgeMinutes: 5,
  });
  assert(refusals.some((one) => one.includes('does not cover it')), 'an overlong sequence was allowed to start');
});

test('a sequence that EXACTLY fills the turn is refused, because the margin is not optional', () => {
  const lifetime = 40;
  const exact = lifetime - ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES;
  assertEq(originStabilityRefusals({
    shortestObservedOriginLifetimeMinutes: lifetime,
    boundedSequenceDurationMinutes: exact,
    originRecordAgeMinutes: 1,
  }).length, 0, 'a sequence exactly at the margin was refused');
  assert(originStabilityRefusals({
    shortestObservedOriginLifetimeMinutes: lifetime,
    boundedSequenceDurationMinutes: exact + 1,
    originRecordAgeMinutes: 1,
  }).some((one) => one.includes('does not cover it')), 'one minute past the margin was allowed');
});

test('an UNMEASURED lifetime is refused rather than assumed generous', () => {
  for (const lifetime of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert(originStabilityRefusals({
      shortestObservedOriginLifetimeMinutes: lifetime,
      boundedSequenceDurationMinutes: 25,
      originRecordAgeMinutes: 1,
    }).some((one) => one.includes('never measured')),
      `a lifetime of ${String(lifetime)} was treated as a measurement`);
  }
});

test('an UNBOUNDED sequence has nothing for a turn to cover', () => {
  assert(originStabilityRefusals({
    shortestObservedOriginLifetimeMinutes: 40,
    boundedSequenceDurationMinutes: undefined,
    originRecordAgeMinutes: 1,
  }).some((one) => one.includes('no bounded duration')), 'an unbounded sequence was allowed');
});

test('a STALE origin record is an answer about a different origin', () => {
  assertEq(originStabilityRefusals({
    shortestObservedOriginLifetimeMinutes: 40,
    boundedSequenceDurationMinutes: 25,
    originRecordAgeMinutes: ORIGIN_RECORD_MAX_AGE_MINUTES,
  }).length, 0, 'a record exactly at the age limit was refused');
  assert(originStabilityRefusals({
    shortestObservedOriginLifetimeMinutes: 40,
    boundedSequenceDurationMinutes: 25,
    originRecordAgeMinutes: ORIGIN_RECORD_MAX_AGE_MINUTES + 1,
  }).some((one) => one.includes('minutes old')), 'a stale record was trusted');
  assert(originStabilityRefusals({
    shortestObservedOriginLifetimeMinutes: 40,
    boundedSequenceDurationMinutes: 25,
  }).some((one) => one.includes('carries no age')), 'a record with no age was trusted');
});

test('a pool LARGER than the allowlist is refused, and widening is named as a blocker', () => {
  const refusals = originStabilityRefusals({
    shortestObservedOriginLifetimeMinutes: 40,
    boundedSequenceDurationMinutes: 25,
    originRecordAgeMinutes: 1,
    allowedOriginCount: 5,
    observedPoolSize: 7,
  });
  assert(refusals.some((one) => one.includes('BLOCKER AND NOT A STEP')),
    'a pool the allowlist cannot cover was allowed, or widening was not named as a blocker');
});

test('a rotation is an ABORT with a reason, and never a FAIL about the product', () => {
  assertEq(originRotationDisposition(0), 'proceed', 'an allowed origin did not proceed');
  assertEq(originRotationDisposition(70), 'abort-origin-rotated', 'a disallowed origin was not an abort');
  for (const status of [1, 2, 77, 124, 137]) {
    assertEq(originRotationDisposition(status), 'abort-not-measured',
      `status ${status} was read as something other than "not measured"`);
  }
  // AND NO STATUS PRODUCES A PRODUCT FAILURE. The type has three members and none of them is one.
  for (const status of [0, 1, 70, 77]) {
    assert(!String(originRotationDisposition(status)).includes('fail'),
      'a recheck status was turned into a failure of the product');
  }
});

h.section('P13PRE-C3 — the budget that nothing measured');

/** §9's table, as a map from finding id to the row's disposition cell. */
function dispositionTable(): ReadonlyMap<string, string> {
  const document = read(CONTRACT);
  const at = document.indexOf('## 9. Every readiness finding, and its disposition');
  assert(at >= 0, `${CONTRACT} has no §9, so no finding can carry a disposition`);
  const section = document.slice(at, document.indexOf('\n## ', at + 10));
  const rows = new Map<string, string>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const id = /^\*\*([BF]\d+)\*\*$/.exec(cells[1] ?? '')?.[1];
    // THE DISPOSITION IS THE LAST CELL, and it is read as a cell rather than searched for anywhere in the
    // row — a row that merely MENTIONS the word "REPAIRED" in its description of the defect has not said
    // what was done about it.
    if (id !== undefined) rows.set(id, cells[cells.length - 2] ?? '');
  }
  return rows;
}

test('every readiness finding has a ROW in §9, and the count is the one the header states', () => {
  const table = dispositionTable();
  const missing = PHASE13_PREENTRY_READINESS_FINDINGS.filter((id) => !table.has(id));
  assertEq(missing.length, 0, `§9 has no row for: ${missing.join(', ')}`);
  // AND NO ROW FOR A FINDING THE REVIEW DID NOT MAKE, which is the other direction and would mean the
  // denominator had quietly grown.
  for (const id of table.keys()) {
    assert(PHASE13_PREENTRY_READINESS_FINDINGS.includes(id),
      `§9 disposes of ${id}, which the readiness review did not raise`);
  }
  // THE HEADER'S OWN ARITHMETIC. Eleven blockers and five findings; neither the sentence nor the list can be
  // edited without the other.
  const blockers = PHASE13_PREENTRY_READINESS_FINDINGS.filter((id) => id.startsWith('B')).length;
  const findings = PHASE13_PREENTRY_READINESS_FINDINGS.filter((id) => id.startsWith('F')).length;
  assertEq(blockers, 11, 'the blocker count moved');
  assertEq(findings, 5, 'the finding count moved');
  assert(read(CONTRACT).includes(`${'whose eleven blockers and five findings'}`),
    'the document no longer states the finding count its §9 table is measured against');
});

test('FINDINGS_WITHOUT_A_DISPOSITION_MAX is MEASURED, and every row says what happened', () => {
  // THE CLAIM HAD A BUDGET AND NOTHING MOVED IT. This is the measurement: a row whose last cell names none
  // of the closed set of dispositions has mentioned a finding without answering it.
  const table = dispositionTable();
  const without = PHASE13_PREENTRY_READINESS_FINDINGS.filter((id) => {
    const disposition = table.get(id) ?? '';
    return !PHASE13_PREENTRY_DISPOSITIONS.some((word) => disposition.includes(word));
  });
  assertEq(without.length, PHASE13_PREENTRY_RULES.FINDINGS_WITHOUT_A_DISPOSITION_MAX,
    `${without.length} finding(s) carry no disposition: ${without.join(', ')}`);
  // AND EVERY OUT-OF-SCOPE ROW NAMES AN OWNER, because "out of scope" without one is a finding dropped
  // rather than assigned.
  for (const id of PHASE13_PREENTRY_READINESS_FINDINGS) {
    const disposition = table.get(id) ?? '';
    if (!disposition.includes('OUT OF SCOPE')) continue;
    assert(/OWNER NAMED/.test(disposition),
      `${id} is out of scope and names no owner, which is a finding dropped rather than assigned`);
  }
});

test('CONTROL: the measurement BITES on a missing row and on a row that says nothing', () => {
  // A CHECK NOBODY HAS WATCHED FAIL IS A CHECK NOBODY SHOULD BELIEVE, and this one exists precisely because
  // the claim it measures went unmeasured. Both directions are driven over a tampered copy of the table.
  const table = new Map(dispositionTable());
  const complete = PHASE13_PREENTRY_READINESS_FINDINGS.filter((id) => !table.has(id));
  assertEq(complete.length, 0, 'the fixture is not a complete table, so this control proves nothing');

  const dropped = new Map(table);
  dropped.delete('B10');
  assertEq(PHASE13_PREENTRY_READINESS_FINDINGS.filter((id) => !dropped.has(id)).join(','), 'B10',
    'removing a row is not seen, so a finding could stop being mentioned without anything noticing');

  const silent = new Map(table);
  silent.set('B11', 'a host observation this run did not take');
  const without = PHASE13_PREENTRY_READINESS_FINDINGS.filter((id) => {
    const disposition = silent.get(id) ?? '';
    return !PHASE13_PREENTRY_DISPOSITIONS.some((word) => disposition.includes(word));
  });
  assertEq(without.join(','), 'B11',
    'a row that mentions a finding without saying what happened to it reads as dispositioned');
});

h.section('the boundary this tranche drew around itself');

test('the ceiling sentence and the meaning are in the document, verbatim', () => {
  const document = prose(CONTRACT);
  for (const sentence of [PHASE13_PREENTRY_CEILING_SENTENCE, PHASE13_PREENTRY_MEANING]) {
    // The document may wrap; the flattened form is what is compared.
    assert(document.includes(sentence.replace(/\s+/g, ' ')),
      `the document does not carry: ${sentence.slice(0, 60)}…`);
  }
});

test('the six preserved states are each stated in the document', () => {
  const document = flat(CONTRACT);
  for (const state of PHASE13_PREENTRY_PRESERVED_STATES) {
    const words = state.split(' ').filter((word) => /^[A-Z0-9]/.test(word) || word.length > 6);
    assert(words.every((word) => document.includes(word.replace(/[,.]$/, ''))),
      `the document does not preserve: ${state}`);
  }
  // AND THE HEADLINE, WHICH IS THE ONE A READER SEES FIRST.
  assert(/PHASE 13 IS NOT ENTERED/.test(read(CONTRACT)),
    'the document does not say in its first lines that Phase 13 is not entered');
  assert(/`P11-R1` is NOT RUN/.test(read(CONTRACT)),
    'the document does not say P11-R1 is NOT RUN');
});

test('every non-claim is refused in the document', () => {
  const document = flat(CONTRACT).toLowerCase();
  for (const nonclaim of PHASE13_PREENTRY_NONCLAIMS) {
    assert(document.includes(nonclaim.toLowerCase()), `the document does not disclaim: ${nonclaim}`);
  }
});

test('this tranche modifies nothing on its own forbidden list', () => {
  for (const path of PHASE13_PREENTRY_TRANCHE_PATHS) {
    assert(!PHASE13_PREENTRY_FORBIDDEN_SOURCE.includes(path),
      `${path} is both modified and forbidden, so the boundary contradicts itself`);
  }
  // AND PHASE 12's OWN MODULE IS ON THE FORBIDDEN LIST. A tranche that could edit the rules it imports is a
  // tranche whose measurement concludes whatever it needs to.
  assert(PHASE13_PREENTRY_FORBIDDEN_SOURCE.includes('src/core/projection/phase12.ts'),
    'phase12.ts is not forbidden, so an imported threshold could be edited on both sides');
});

/**
 * Every path in the document's §11 ownership table.
 *
 * THE TABLE IS THE AUTHORITY AND THE MODULE HOLDS A SUBSET, for the reason the module states: three of the
 * scripts this tranche repairs carry the provider's name in their filename, and a `src/` file that named one
 * would mean widening eight provider boundaries for a string. So the soak question is asked of the UNION,
 * and the parse fails loudly rather than quietly returning nothing.
 */
function ownershipTablePaths(): readonly string[] {
  const document = read(CONTRACT);
  const at = document.indexOf(PHASE13_PREENTRY_OWNERSHIP_SECTION);
  assert(at >= 0, `${CONTRACT} has no section titled "${PHASE13_PREENTRY_OWNERSHIP_SECTION}", so the `
    + 'complete ownership list cannot be read and the soak question would be asked of a subset');
  return ownershipSectionPaths(document.slice(at));
}

test('the ownership table is complete: it holds every path the module names, and more', () => {
  const table = ownershipTablePaths();
  assert(table.length >= PHASE13_PREENTRY_TRANCHE_PATHS.length,
    'the ownership table names fewer paths than the module does, so it is not the authority it claims to be');
  for (const path of PHASE13_PREENTRY_TRANCHE_PATHS) {
    assert(table.includes(path), `${path} is in the module's list but not in the document's §11 table`);
  }
  // AND IT NAMES THE THREE THE MODULE DELIBERATELY CANNOT. If it stopped naming them the subset would look
  // complete, which is the exact failure this split has to be protected against.
  for (const path of [
    'deploy/projection-torbox-real-gate.sh',
    'deploy/projection-torbox-real-gate-optional.sh',
    'deploy/projection-torbox-mount-gate-optional.sh',
  ]) {
    assert(table.includes(path), `${path} is repaired by this tranche but is not in the document's §11 table`);
  }
});

/**
 * The paths every ownership table in this repository's POST-CANDIDATE phase documents claims.
 *
 * WHY THE UNION AND NOT JUST §11. This document's §11 is the authority for THIS tranche, and the branch it
 * sits on carries later tranches too — a Phase 13 preparation's contract, its module, its suites. Checking
 * "every file the branch touched is in §11" would make this tranche's own record fail the moment a
 * successor landed a file of its own, and the fix somebody would reach for is to weaken the check.
 *
 * THE SET OF DOCUMENTS IS DECIDED BY GIT RATHER THAN BY A LIST HERE. A phase document ADDED since the
 * candidate belongs to work done since the candidate, and its ownership table is the authority for that
 * work. A document that already existed at the candidate — Phase 12's, Phase 11's — is not consulted, so a
 * change to a file an EARLIER tranche owns is still unlisted here, which is exactly the direction that must
 * not be excused. The property this preserves is the strong one: **every file this branch touched is claimed
 * by some tranche whose work is on this branch.**
 */
function ownershipSectionPaths(document: string): readonly string[] {
  const at = document.search(/^## \d+\. File ownership/m);
  if (at < 0) return [];
  const section = document.slice(at);
  const paths: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const first = line.split('|')[1]?.trim() ?? '';
    const match = /^`([^`]+)`$/.exec(first);
    // EVERY EXTENSION THESE TRANCHES ACTUALLY TOUCH, PLUS DOTFILES. A parser that knew four extensions
    // silently dropped the two Compose files and `.gitignore` from the table it was checking — so the
    // bidirectional check reported them as unlisted when they were listed, which is the same class of "the
    // check and the thing it checks disagree about what counts" this whole pass is about.
    if (match?.[1] !== undefined
      && /^[\w./-]*\.(ts|sh|json|md|yml|yaml|gitignore|gitattributes)$/.test(match[1])) {
      paths.push(match[1]);
    }
  }
  return paths;
}

test('every path §11 claims as modified WAS modified, driven against git, and it FAILS when it cannot ask', () => {
  // THE DIRECTION THE COMPLETENESS CHECK COULD NOT SEE. It asserted table ⊇ module, so a row naming a file
  // NOTHING TOUCHED was structurally invisible — and an independent audit found exactly one:
  // `test/projection-phase12.ts`, listed as carrying a control that in fact lives in the gate-audit suite.
  //
  // AND IT USED TO RECORD A PASS WHEN IT COULD NOT ASK. A re-audit named that: `assert(true, …); return` on
  // a missing candidate commit registers a PASSING check, in a tranche whose own §4 refuses to fold a skip
  // into a pass. The harness has no third verdict, so the honest one is the closed one — a checkout that
  // cannot answer "was this file modified" has not answered it, and the suite says so by failing. Every
  // shell this repository runs its offline inventory from is a git checkout with the candidate in it; a
  // tree without one is a tree this check was never measured on.
  const base = /\| Candidate \| integration `([0-9a-f]{7,40})`/.exec(read(CONTRACT))?.[1];
  assert(base !== undefined, 'the document names no candidate, so nothing can say what "modified" means');
  const rev = spawnSync('git', ['rev-parse', '--verify', `${base}^{commit}`],
    { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
  assertEq(rev.status, 0,
    `the candidate ${String(base)} cannot be resolved in this checkout, so the ownership table is UNCHECKED `
    + 'rather than complete. This fails closed: an unasked question is not an answered one');

  const diff = spawnSync('git', ['diff', '--name-only', `${base}..HEAD`],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
  assertEq(diff.status, 0, 'git could not list what this branch changed');
  const changed = new Set(String(diff.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean));
  assert(changed.size > 0, 'git reports no change at all, so this check is measuring nothing');

  // EVERY ROW NAMES A FILE THIS BRANCH ACTUALLY TOUCHED.
  const phantom = ownershipTablePaths().filter((path) => !changed.has(path));
  assertEq(phantom.length, 0,
    `§11 claims these paths but the branch does not touch them: ${phantom.join(', ')}`);

  // AND EVERY FILE THIS BRANCH TOUCHED IS CLAIMED BY SOME POST-CANDIDATE TRANCHE'S OWNERSHIP TABLE. The
  // other direction, so a file can no longer be changed without an ownership record saying so.
  const added = spawnSync('git', ['diff', '--name-only', '--diff-filter=A', `${base}..HEAD`, '--', 'docs/'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
  assertEq(added.status, 0, 'git could not list the documents this branch adds');
  const claimed = new Set(ownershipTablePaths());
  for (const doc of String(added.stdout ?? '').split('\n').map((one) => one.trim()).filter(Boolean)) {
    if (!doc.endsWith('.md')) continue;
    for (const path of ownershipSectionPaths(read(doc))) claimed.add(path);
  }
  assert(claimed.size >= ownershipTablePaths().length,
    'the union of post-candidate ownership tables is smaller than §11 alone, so the parse is suspect');
  const unlisted = [...changed].filter((path) => !claimed.has(path));
  assertEq(unlisted.length, 0,
    `these paths are modified by the branch and no post-candidate ownership table lists them: ${unlisted.join(', ')}`);
});

/**
 * §10.3's "New (n)" and "Modified (n)" counts, read out of the document.
 *
 * THE PARAGRAPH END IS FOUND WITH A REGEX AND NOT WITH `indexOf('\n\n')`, and that is not a style
 * preference. `.gitattributes` pins `*.sh` and `*.go` to LF and nothing else, so a `.md` file is LF in the
 * worktree an agent wrote it in and CRLF in an ordinary Windows checkout of the SAME COMMIT. A bare-LF
 * blank-line literal misses in the CRLF one, `indexOf` answers `-1`, and `slice(at, -1)` is not "no match" —
 * it is THE REST OF THE FILE. That mis-slice fails silently in both directions, and this repository has paid
 * four release baselines for it; `test/helpers/ts-source.ts` exists because of it.
 *
 * AND IT REFUSES RATHER THAN RETURNING A REGION IT IS NOT SURE OF, which is that helper's whole rule.
 */
function modifiedEnumeration(document: string): { stated: number; newStated: number; paragraph: string } {
  const at = document.indexOf('**Modified (');
  assert(at >= 0, '§10.3 no longer enumerates the modified files, so this check has nothing to compare');
  const end = /\r?\n\r?\n/.exec(document.slice(at));
  assert(end !== null,
    '§10.3\'s enumeration runs to the end of the document with no blank line after it, so the paragraph '
    + 'boundary this check needs does not exist and nothing here is measuring a paragraph');
  const paragraph = document.slice(at, at + end.index);
  const stated = Number(/\*\*Modified \((\d+)\)/.exec(paragraph)?.[1]);
  const newStated = Number(/\*\*New \((\d+)\)/.exec(document)?.[1]);
  assert(Number.isFinite(stated) && Number.isFinite(newStated),
    '§10.3 no longer states a New and a Modified count, so there is nothing to compare against §11');
  return { stated, newStated, paragraph };
}

test('CONTROL: every document parser here answers the same on a CRLF rendering of the same commit', () => {
  // THE DEFECT CLASS, DRIVEN. Two worktrees on the same commit do not have the same bytes on disk: an agent
  // writes LF, an ordinary Windows checkout of the identical tree hash is CRLF, and `git status` reports
  // clean either way because the index normalises. So a suite green here can be red in a fresh clone for a
  // reason that is not in the commit at all. The fix is not to normalise the checkout; it is for every
  // parser to answer the same in both, which is what this drives.
  const lf = read(CONTRACT).replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  assert(crlf.includes('\r\n') && !lf.includes('\r'), 'the two renderings are not actually different');

  assertEq(ownershipSectionPaths(crlf).join(','), ownershipSectionPaths(lf).join(','),
    'the ownership table parses differently under CRLF, so the completeness check is about a line ending');
  const a = modifiedEnumeration(lf);
  const b = modifiedEnumeration(crlf);
  assertEq(b.stated, a.stated, '§10.3\'s modified count reads differently under CRLF');
  assertEq(b.newStated, a.newStated, '§10.3\'s new count reads differently under CRLF');
  // AND THE PARAGRAPH IS A PARAGRAPH IN BOTH, rather than the rest of the file in one of them.
  assert(b.paragraph.length < crlf.length / 4,
    'the paragraph found under CRLF is most of the document, which is the silent mis-slice this exists for');
  assertEq(b.paragraph.replace(/\r/g, ''), a.paragraph, 'the two renderings yield different paragraphs');
});

test('§10.3\'s enumeration and §11\'s table name the same files, so the prose cannot drift again', () => {
  // WHY THIS CHECK EXISTS. §10.3 said "Modified (11)" and git said fifteen; the four the correction pass
  // added were never added to it, including `src/core/projection/real-provider.ts`, which carries the D1
  // repair. §11 was right the whole time and is bidirectionally enforced — §10.3 was **measured by nothing**,
  // which is the only reason the two could disagree. Now they cannot.
  const document = read(CONTRACT);
  const { stated, newStated } = modifiedEnumeration(document);
  const table = ownershipTablePaths();
  assertEq(stated + newStated, table.length,
    `§10.3 accounts for ${newStated} new plus ${stated} modified and §11 lists ${table.length} paths`);

  // AND EVERY FILE §11 NAMES IS NAMED IN THE PROSE, by path or by an unambiguous group. The four wrappers
  // and the two provider gates are named collectively there on purpose — a paragraph that spelled out
  // twenty paths is a paragraph nobody reads — so the ones checked by name are everything else.
  const grouped = new Set([
    'deploy/projection-real-provider-gate.sh', 'deploy/projection-torbox-real-gate.sh',
    'deploy/projection-real-provider-gate-optional.sh', 'deploy/projection-torbox-real-gate-optional.sh',
    'deploy/projection-torbox-mount-gate-optional.sh', 'deploy/projection-path-lifecycle-gate-optional.sh',
  ]);
  const section = document.slice(document.indexOf('### 10.3'), document.indexOf('### 10.4'));
  for (const path of table) {
    if (grouped.has(path)) continue;
    assert(section.includes(path.split('/').pop() ?? path),
      `§11 names ${path} and §10.3 does not mention it, so the two records disagree again`);
  }
});

test('CONTROL: the ownership union bites on a dropped row and on a document that claims nothing', () => {
  // A CHECK NOBODY HAS WATCHED FAIL IS A CHECK NOBODY SHOULD BELIEVE, and this one has two ways to go
  // vacuous: a parser that finds no section returns an empty list quietly, and a union that swallowed an
  // unlisted path would report zero for the same reason a stopped-part-way inventory does.
  const document = read(CONTRACT);
  const rows = ownershipSectionPaths(document);
  assert(rows.length >= 15, `the §11 parse found only ${rows.length} rows, so the union is built on almost nothing`);

  // A ROW REMOVED IS A PATH NO LONGER CLAIMED.
  const dropped = ownershipSectionPaths(
    document.split('\n').filter((line) => !line.startsWith('| `package.json` |')).join('\n'));
  assert(rows.includes('package.json') && !dropped.includes('package.json'),
    'dropping a row from the table did not drop it from the parse, so the union cannot notice a missing one');

  // AND A DOCUMENT WITH NO OWNERSHIP SECTION CLAIMS NOTHING, rather than claiming everything it happens to
  // mention in a table. That is what keeps the union from quietly excusing a path.
  assertEq(ownershipSectionPaths('# a document\n\n| a | b |\n|---|---|\n| `src/x.ts` | new |\n').length, 0,
    'a document with no File ownership section still claimed a path, so any table anywhere would excuse one');
});

test('PHASE 9: nothing this tranche touches triggers a soak re-run', () => {
  const union = [...new Set([...PHASE13_PREENTRY_TRANCHE_PATHS, ...ownershipTablePaths()])];
  assert(union.length > PHASE13_PREENTRY_TRANCHE_PATHS.length,
    'the union is no larger than the module\'s list, so the table added nothing and the parse is suspect');
  assertEq(phase9RequiresSoakRerun(union), false,
    'a path this tranche modifies is on PHASE9_SOAK_TRIGGERING_SOURCE, so Phase 9\'s soak must be re-run');
});

test('the module names no provider, so no source allowlist had to be widened', () => {
  // PHASE 11 §6.2 PAID FOR THIS LESSON: all eight provider suites scan `src/` and refuse an unlisted file
  // that names the provider, and "five" was a conclusion drawn from an inventory run stopped part-way.
  // `phase12.ts` avoided the whole question by not naming one; so does this module.
  assert(!/torbox/i.test(read(MODULE)), 'the module names the provider, so eight allowlists now have to move');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase13-preentry.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase13-preentry.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

test('the tranche is reachable from a named npm script', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  for (const name of ['test:phase13-preentry', 'go:preentry-readiness']) {
    assert(name in scripts, `${name} is not an npm script, so nobody can run it the documented way`);
  }
});

await h.finish();
