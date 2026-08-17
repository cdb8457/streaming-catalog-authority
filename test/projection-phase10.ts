import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  PHASE10_CLOSURE_GATE_IDS,
  PHASE10_DIVERGENCE_CODES,
  PHASE10_FOREIGN_DISPATCH_SUITES,
  PHASE10_FORBIDDEN_SOURCE,
  PHASE10_GATE_PG_PORT,
  PHASE10_GATE_TITLES,
  PHASE10_HOLD_REASON,
  PHASE10_INTEGRATION_DEPENDENT_GATE_IDS,
  PHASE10_NONCLAIMS,
  PHASE10_PHASE9_PREREQUISITE,
  PHASE10_PROVIDER_FREE_GATE_IDS,
  PHASE10_PROVIDER_REQUIRED_GATE_IDS,
  PHASE10_REHEARSAL_EMITTABLE_GATE_IDS,
  PHASE10_RULES,
  PHASE10_SEQUENCE_LEVEL_GATE_IDS,
  PHASE10_TRANCHE_PATHS,
  PHASE10_UNTOUCHABLE_PHASE9_CLAIMS,
  phase10BudgetKeyFor,
  phase10Closed,
  phase10ClosureProblems,
  type Phase10GateResult,
  type Phase10Results,
} from '../src/core/projection/phase10.js';
import { PHASE9_RULES, phase9RequiresSoakRerun } from '../src/core/projection/phase9.js';
import { PROJECTION_DEGRADED_REASONS } from '../src/core/projection/manifest-v1.js';

// Projection Phase 10 — the tranche's own rules, offline.
//
// WHAT THIS SUITE IS FOR. The rehearsal needs Docker and a real migrated PostgreSQL. This runs everywhere in
// milliseconds and pins the things a real run cannot check about itself:
//
//   * that every threshold is IMPORTED from the closed tranche it claims to come from, so a number cannot be
//     re-derived here and drift from the one the product is built on;
//   * that the four NEW ones are the four the contract names, at the values it names, and every one is zero;
//   * that the ten §5 claims are the document's ten, in the document's order;
//   * that a REHEARSAL verdict cannot close a claim about a set of runs — the single property that keeps a
//     green rehearsal from reading as a closure;
//   * that a skip, a duplicate verdict, a short run or a budget a run supplied for itself is not success;
//   * that this tranche does not re-open the Phase 8 soak, ASSERTED by running the contract's own function;
//   * and that the seven suites belonging to another dispatch were not edited by this one.

const h = createHarness('Projection Phase 10 — the tranche rules, offline');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

/**
 * A document with its line wrapping flattened.
 *
 * EVERY PROSE ASSERTION BELOW USES THIS. A pin that searched the raw bytes would pass or fail on where a
 * sentence happened to wrap, which is a property of the editor rather than of the claim - and the first time
 * it broke for that reason somebody would delete the pin instead of the wrap.
 */
const flat = (relative: string): string => read(relative).replace(/\s+/g, ' ');

const CONTRACT = 'docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md';
const RUNBOOK = 'docs/PROJECTION_CONTENT_OPERATOR_RUNBOOK.md';
const PHASE9_RUNBOOK = 'docs/PROJECTION_PHASE_9_USENET_RUNBOOK.md';
const COMPOSE = 'docker-compose.projection-phase10.yml';
const REHEARSAL = 'deploy/projection-phase10-rehearsal.sh';
const CONTENT_SCRIPT = 'deploy/projection-content.sh';

const okResult = (gate: string): Phase10GateResult => {
  const key = phase10BudgetKeyFor(gate);
  if (key === undefined) return { gate, verdict: 'pass' };
  const budget = PHASE10_RULES[key];
  return { gate, verdict: 'pass', budget, measured: key === 'CONSECUTIVE_FRESH_RUNS' ? budget : 0 };
};
const fullRun = (): Phase10Results => ({
  sequences: [{ index: 1 }, { index: 2 }, { index: 3 }],
  results: PHASE10_CLOSURE_GATE_IDS.map(okResult),
});

h.section('the ten claims, and the document they come from');

test('the gate ids are the document\'s ten claims, numbered in the document\'s own order', () => {
  assertEq(PHASE10_CLOSURE_GATE_IDS.length, 10, 'ten claims');
  const contract = read(CONTRACT);
  let cursor = 0;
  for (const id of PHASE10_CLOSURE_GATE_IDS) {
    const number = id.slice(0, id.indexOf('-', 4));
    const at = contract.indexOf(`**${number}**`, cursor);
    assert(at > 0, `${number} is not named in §5, or is out of the document's order`);
    cursor = at;
  }
});

test('every claim has a one-line title, and no title names a path, a URL or an identity', () => {
  for (const id of PHASE10_CLOSURE_GATE_IDS) {
    const title = PHASE10_GATE_TITLES[id];
    assert(typeof title === 'string' && title.length > 0, `${id} has no title`);
    assert(!/https?:\/\/|\/mnt\/|\/var\//.test(title), `${id}'s title names a path or a URL`);
  }
});

test('the provider-free and provider-required lists are a partition, and NOTHING is provider-required', () => {
  assertEq(PHASE10_PROVIDER_REQUIRED_GATE_IDS.length, 0,
    'a Phase 10 claim needs a provider, and §5 says a claim that does belongs in Phase 11');
  assertEq(PHASE10_PROVIDER_FREE_GATE_IDS.length, PHASE10_CLOSURE_GATE_IDS.length, 'all ten are provider-free');
});

test('the sequence-level and rehearsal-emittable lists are a partition of the ten', () => {
  const union = [...PHASE10_SEQUENCE_LEVEL_GATE_IDS, ...PHASE10_REHEARSAL_EMITTABLE_GATE_IDS].sort();
  assertEq(union.join(','), [...PHASE10_CLOSURE_GATE_IDS].sort().join(','), 'the two lists are not a partition');
  assertEq(PHASE10_SEQUENCE_LEVEL_GATE_IDS.length, 4, 'four claims are about a set of runs');
});

h.section('the thresholds');

test('every imported threshold is the value the tranche it came from holds, read from that module', () => {
  assertEq(PHASE10_RULES.CONSECUTIVE_FRESH_RUNS, PHASE9_RULES.CONSECUTIVE_FRESH_RUNS, 'the repetition count');
  assertEq(PHASE10_RULES.OPERATOR_INTERVENTIONS_MAX, PHASE9_RULES.OPERATOR_INTERVENTIONS_MAX, 'interventions');
  assertEq(PHASE10_RULES.RESIDUE_MAX, PHASE9_RULES.RESIDUE_MAX, 'residue');
});

test('the four NEW thresholds are the four §5.1 names, and every one of them is ZERO', () => {
  for (const key of ['ADMISSIONS_WITHOUT_DRIFT_CHECK_MAX', 'AUTOMATIC_NAMESPACE_MUTATIONS_MAX',
    'HAND_RUN_COMMANDS_MAX', 'GENERATION_BYTES_CHANGED_BY_REPORT_MAX'] as const) {
    assertEq(PHASE10_RULES[key], 0, `${key} is not zero, and every one of the four is the whole point`);
    assert(read(CONTRACT).includes(key), `${key} is not in §5.1 of the contract`);
  }
});

test('a claim with a budget names one §5.1 gives it, and a claim without one has nothing to measure', () => {
  for (const id of PHASE10_CLOSURE_GATE_IDS) {
    const key = phase10BudgetKeyFor(id);
    if (key === undefined) continue;
    assert(key in PHASE10_RULES, `${id} is measured against ${key}, which §5.1 does not name`);
  }
});

h.section('closure — what a run may not be read as');

test('a complete, honest run closes', () => {
  assertEq(phase10ClosureProblems(fullRun()).join(' | '), '', 'a complete run reported a problem');
  assertEq(phase10Closed(fullRun()), true, 'a complete run did not close');
});

test('a REHEARSAL verdict cannot close a claim about a set of runs, and CAN close the other six', () => {
  for (const id of PHASE10_SEQUENCE_LEVEL_GATE_IDS) {
    const results = fullRun();
    const problems = phase10ClosureProblems({
      ...results,
      results: results.results.map((one) => (one.gate === id ? { ...one, rehearsal: true } : one)),
    });
    assert(problems.some((problem) => problem.includes(id)),
      `${id} closed on one rehearsal run, and it is a claim about a set of runs this one is not a member of`);
  }
  for (const id of PHASE10_REHEARSAL_EMITTABLE_GATE_IDS) {
    const results = fullRun();
    const problems = phase10ClosureProblems({
      ...results,
      results: results.results.map((one) => (one.gate === id ? { ...one, rehearsal: true } : one)),
    });
    assertEq(problems.join(' | '), '', `${id} could not be answered by the rehearsal that exists to answer it`);
  }
});

test('a skip is never folded into a pass, and a skipped integration-dependent claim says why', () => {
  const results = fullRun();
  const problems = phase10ClosureProblems({
    ...results,
    results: results.results.map((one) =>
      (one.gate === PHASE10_INTEGRATION_DEPENDENT_GATE_IDS[0] ? { gate: one.gate, verdict: 'skip' as const } : one)),
  });
  assert(problems.some((problem) => /POSIX-shell harness repair/.test(problem)),
    'a claim blocked on another dispatch was skipped and the report did not say what it was waiting for');
});

test('a short run, a missing verdict and a duplicated verdict are each refused', () => {
  const short = phase10ClosureProblems({ ...fullRun(), sequences: [{ index: 1 }] });
  assert(short.some((problem) => /fresh sequences/.test(problem)), 'a one-sequence run closed');

  const missing = fullRun();
  const withoutOne = phase10ClosureProblems({
    ...missing, results: missing.results.slice(1),
  });
  assert(withoutOne.some((problem) => /has no verdict/.test(problem)), 'an absent verdict read as a pass');

  const duplicated = fullRun();
  const twice = phase10ClosureProblems({
    ...duplicated, results: [...duplicated.results, okResult(PHASE10_CLOSURE_GATE_IDS[0])],
  });
  assert(twice.some((problem) => /more than one verdict/.test(problem)), 'a duplicated verdict read as confirmation');
});

test('a run cannot supply its own budget, nor pass while exceeding the contract\'s', () => {
  const target = 'P10-3-drift-guard-runs-on-real-admission';
  const invented = fullRun();
  const wrongBudget = phase10ClosureProblems({
    ...invented,
    results: invented.results.map((one) => (one.gate === target ? { ...one, budget: 99 } : one)),
  });
  assert(wrongBudget.some((problem) => /rather than against the/.test(problem)), 'a run supplied its own budget');

  const overBudget = phase10ClosureProblems({
    ...invented,
    results: invented.results.map((one) => (one.gate === target ? { ...one, measured: 1 } : one)),
  });
  assert(overBudget.some((problem) => /while reporting 1/.test(problem)),
    'an admission that skipped the drift check passed against a budget of zero');
});

test('a claim with no budget cannot report a measurement it invented', () => {
  const target = 'P10-9-evidence-carries-no-identity';
  const results = fullRun();
  const problems = phase10ClosureProblems({
    ...results,
    results: results.results.map((one) => (one.gate === target ? { ...one, measured: 0, budget: 0 } : one)),
  });
  assert(problems.some((problem) => /a budget §5.1 does not give it/.test(problem)),
    'a pass/fail claim reported a measurement against a budget the contract never set');
});

test('an id §5 does not name is refused rather than counted', () => {
  const results = fullRun();
  const problems = phase10ClosureProblems({
    ...results, results: [...results.results, { gate: 'P10-11-invented', verdict: 'pass' }],
  });
  assert(problems.some((problem) => /which §5 does not name/.test(problem)), 'an invented id was accepted');
});

h.section('§4 — the refusals that are checkable');

test('this tranche does NOT re-open the Phase 8 soak, asserted by running the contract\'s own function', () => {
  // P10-6, DRIVEN. `phase9RequiresSoakRerun` is the decision procedure Phase 9 §5 encodes; a suite that
  // re-implemented the rule could disagree with the product about whether a six-hour soak has to be re-run.
  assertEq(phase9RequiresSoakRerun(PHASE10_TRANCHE_PATHS), false,
    'a path this tranche touches is on PHASE9_SOAK_TRIGGERING_SOURCE, which re-opens three consecutive soaks '
    + 'plus Phase 7\'s whole sequence against a rotating CDN pool');
});

test('every path the tranche claims to touch exists, so the list cannot go quietly stale', () => {
  for (const path of PHASE10_TRANCHE_PATHS) {
    assert(existsSync(join(repoRoot, path)), `${path} is on the tranche's own path list and is not in the tree`);
  }
});

test('the forbidden source is still there and is not on the tranche\'s own list', () => {
  for (const path of PHASE10_FORBIDDEN_SOURCE) {
    assert(existsSync(join(repoRoot, path)), `${path} is forbidden to modify and has gone missing`);
    assert(!PHASE10_TRANCHE_PATHS.includes(path), `${path} is both forbidden and claimed as touched`);
  }
});

test('the seven suites another dispatch owns are NOT on this tranche\'s path list', () => {
  // §2.6 and §6.3. Two dispatches editing the same seven files is the collision §6 exists to prevent, and
  // naming the boundary in code is what lets a suite assert it held.
  for (const suite of PHASE10_FOREIGN_DISPATCH_SUITES) {
    assert(existsSync(join(repoRoot, suite)), `${suite} has gone missing`);
    assert(!PHASE10_TRANCHE_PATHS.includes(suite),
      `${suite} belongs to dispatch task_49ab24180bd0 and this tranche claims to have edited it`);
  }
});

test('Phase 10 adds no degraded reason, no source kind and no manifest field', () => {
  assertEq(PHASE10_HOLD_REASON, 'operator-hold', 'the hold reason');
  assert((PROJECTION_DEGRADED_REASONS as readonly string[]).includes(PHASE10_HOLD_REASON),
    'the reason this tranche uses has left the contract\'s closed set');
  // THE CHECK IS ABOUT SOURCE KINDS, NOT ABOUT EVERY `kind:` IN THE FILE. `ContentFileStat` has a `kind` of
  // its own - file, directory, symlink, other, missing - and a pattern broad enough to catch it would be a
  // pattern that fails on an unrelated field and gets deleted the first time somebody adds one.
  const content = read('src/ops/projection-content.ts');
  for (const match of content.matchAll(/sources:\s*\[\{\s*kind:\s*'([a-z-]+)'/g)) {
    assert(match[1] === 'local' || match[1] === 'http-range',
      `the content plane registers a source of kind ${String(match[1])}, and §4's first hard refusal is that `
      + 'this tranche adds no source kind');
  }
  assert(!/PROJECTION_DEGRADED_REASONS\s*=/.test(content), 'the content plane redefines the degraded reasons');
  assert(!/degradeEntry\([^)]*'(?!operator-hold)[a-z-]+'/.test(content),
    'the content plane degrades with a reason other than operator-hold');
});

test('the four Phase 9 claims are named as untouchable, and no Phase 10 file records a P9- verdict', () => {
  assertEq(PHASE10_UNTOUCHABLE_PHASE9_CLAIMS.length, 4, 'four open Phase 9 claims');
  for (const relative of ['src/core/projection/phase10.ts', REHEARSAL, 'src/ops/projection-content.ts']) {
    const body = read(relative);
    assert(!/VERDICT\s+P9-|verdict\(\s*['"]P9-/.test(body),
      `${relative} records a P9- verdict, and Phase 9's own document is the only place one may be written`);
  }
});

test('the contract states the Phase 9 prerequisite, and the module carries the same sentence', () => {
  assert(PHASE10_PHASE9_PREREQUISITE.includes('Phase 10-or-later candidate'), 'the prerequisite');
  const contract = flat(CONTRACT);
  assert(/Phase 10-or-later candidate/.test(contract), '§8 does not state the prerequisite');
  assert(/does not close, partially satisfy, re-label or re-word any Phase 9 claim/i.test(contract),
    '§8 does not say that it closes no Phase 9 claim');
});

test('the contract still states every non-claim, so a summary cannot grow one', () => {
  const contract = flat(CONTRACT).toLowerCase();
  for (const nonclaim of PHASE10_NONCLAIMS) {
    assert(contract.includes(nonclaim.toLowerCase()), `§9 no longer says this tranche is not ${nonclaim}`);
  }
});

h.section('PHASE 12 §11 D7 — the operator path begins at zero, and the zero is asserted');

test('the registry is RESET between P10-3 and the operator path, and the reset is CHECKED', () => {
  // THE DEFECT, FOUND BY THE FIRST RUN THAT EVER REACHED A REAL HOST. `test/projection-drift-guard-db.ts`
  // inherits the rehearsal's exported `DATABASE_URL` — deliberately, because P10-3's whole subject is the
  // shipped publisher against a REAL migrated database — and leaves its own roots, versions and entries in
  // the registry P10-4 then measures. P10-4 read FIVE registered entries after adding one, its `add-torbox`
  // collided with the suite's own `remote-one` version and returned a bare SQLSTATE `P0001`, and P10-5
  // inherited the same five. Two arms red, one cause, and both steps individually correct.
  const code = read(REHEARSAL).replace(/^\s*#.*$/gm, '');
  const driftAt = code.indexOf('npx tsx test/projection-drift-guard-db.ts');
  // THE REGION IS SLICED BETWEEN THE DRIFT SUITE AND THE OPERATOR INPUTS, not searched for from the top of
  // the file: `down -v --remove-orphans` also appears in the EXIT trap, several hundred lines earlier, and an
  // `indexOf` from the start would have found the trap's copy and passed on a rehearsal with no reset at all.
  const inputsAt = code.indexOf('MEDIA_ROOT="$WORK/media"');
  assert(driftAt > 0, 'the rehearsal no longer drives the drift suite, which is P10-3 itself');
  assert(inputsAt > driftAt, 'the operator inputs are no longer prepared after P10-3');
  const between = code.slice(driftAt, inputsAt);
  assert(between.includes('down -v --remove-orphans'),
    'the throwaway database is not destroyed between the drift suite writing to it and the operator path '
    + 'measuring it');
  assert(between.includes('migrate-cli.ts'),
    'the re-created database is never migrated, so every verb below it would fail on a missing schema');
  const resetAt = driftAt + between.indexOf('down -v --remove-orphans');

  // AND THE ZERO IS ASSERTED RATHER THAN ASSUMED, which is the half that would have CAUGHT this rather than
  // merely repaired it. A reset nobody checks is a reset that stops working silently.
  const zeroAt = code.indexOf('counts.registered 0');
  assert(zeroAt > resetAt, 'nothing asserts that the operator path begins at zero');
  const firstAdd = code.indexOf('content add-local --file "$LOCAL_OBJECTS"');
  assert(firstAdd > 0 && zeroAt < firstAdd,
    'the zero is asserted after the first add, so it is a statement about the run rather than about its start');
  // IT IS A `fail` AND NOT A VERDICT, because it is a PRECONDITION of the measurement rather than one of the
  // ten claims: a run that begins with entries in the registry is not measuring the operator path at all.
  assert(/counts\.registered 0 \\\n\s*\|\| fail /.test(read(REHEARSAL)),
    'a non-zero starting registry is recorded as a claim\'s verdict rather than aborting the measurement');
});

h.section('the compose file and its port');

test('the rehearsal port collides with no other compose file, and the project is its own', () => {
  const compose = read(COMPOSE);
  const match = /:-(\d{4})\}:5432/.exec(compose);
  assert(match !== null, 'the compose file publishes no recognisable PostgreSQL port');
  assertEq(Number(match[1]), PHASE10_GATE_PG_PORT, 'the Phase 10 port');
  assert(compose.includes('name: projection-phase10-gate'), 'the compose project is not its own');

  for (const entry of readdirSync(repoRoot)) {
    if (!entry.startsWith('docker-compose.') || entry === COMPOSE) continue;
    const other = read(entry);
    assert(!other.includes(`${PHASE10_GATE_PG_PORT}:5432`) && !other.includes(`:-${PHASE10_GATE_PG_PORT}}`),
      `${entry} already binds ${PHASE10_GATE_PG_PORT}, so two gates could lend each other state`);
  }
});

test('the database is throwaway, and the compose file names no provider', () => {
  const compose = read(COMPOSE);
  assert(/tmpfs/.test(compose) && /\/var\/lib\/postgresql\/data/.test(compose),
    'the gate database survives its container, so three fresh runs would not be fresh');
  const body = compose.replace(/^#.*$/gm, '');
  assert(!/torbox|sabnzbd|nntp|endpoint\.json/i.test(body), 'the compose file names a provider');
});

h.section('the documents');

test('the Phase 9 runbook keeps its false sentences WHOLE and marks them superseded', () => {
  const runbook = flat(PHASE9_RUNBOOK);
  // THE FALSE TEXT IS STILL THERE. This repository does not delete a wrong sentence; it retires it, and a
  // page that quietly removed a claim it once made is a page nobody can audit.
  assert(runbook.includes('A Usenet file becomes visible when it is **admitted**, and never before.'),
    'the false §1 sentence was deleted rather than superseded');
  assert(runbook.includes('| `admitted` | proved and published, exactly once | nothing; it is in the namespace |'),
    'the false §4.2 row was deleted rather than superseded');
  assert(/SUPERSEDED BY PROJECTION PHASE 10/.test(runbook), 'nothing marks the false text as superseded');
  assert(/admitted-not-published/.test(runbook), 'the correction does not name the state that replaces it');
  assert(/there is no seventh" IS STILL TRUE/.test(runbook),
    'the correction does not say the six job states are unchanged, which is what stops a reader concluding a '
    + 'closed tranche\'s vocabulary moved');
});

test('the content runbook says publishing is explicit before it says anything else', () => {
  const runbook = read(RUNBOOK);
  const first = runbook.indexOf('Registering an entry does not publish it');
  assert(first > 0 && first < runbook.indexOf('## 2.'),
    'the runbook does not put the one thing that is easy to get wrong first');
  assert(/provider-free/i.test(runbook.slice(0, 600)), 'the runbook does not open by saying it is provider-free');
});

test('the shipped content script is not on any list that would re-open a soak', () => {
  assert(existsSync(join(repoRoot, CONTENT_SCRIPT)), 'the shipped content command is missing');
  assertEq(phase9RequiresSoakRerun([CONTENT_SCRIPT]), false, 'the content script re-opens the Phase 8 soak');
});

h.section('the divergence set');

test('the six divergence codes are §3.3\'s six, in the document\'s order', () => {
  const contract = read(CONTRACT);
  let cursor = 0;
  for (const code of PHASE10_DIVERGENCE_CODES) {
    const at = contract.indexOf(`\`${code}\``, cursor);
    assert(at > 0, `${code} is not in §3.3, or is out of the document's order`);
    cursor = at;
  }
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase10.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase10.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

test('every Phase 10 suite and script is reachable from a named npm script', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  for (const name of ['go:phase10-rehearsal', 'go:phase10-rehearsal:three', 'go:phase10-rehearsal:optional',
    'test:phase10', 'test:projection-drift-guard-db', 'test:projection-content-db', 'ops:projection-content']) {
    assert(name in scripts, `${name} is not an npm script, so nobody can run it the documented way`);
  }
});

await h.finish();
