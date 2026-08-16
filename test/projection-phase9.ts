import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  PHASE9_CLOSURE_GATE_IDS,
  PHASE9_GATE_TITLES,
  PHASE9_JOB_STATES,
  PHASE9_NONCLAIMS,
  PHASE9_OPERATOR_INPUTS,
  PHASE9_PROVIDER_FREE_GATE_IDS,
  PHASE9_PROVIDER_REQUIRED_GATE_IDS,
  PHASE9_RULES,
  PHASE9_SERVER_IDS,
  PHASE9_SOAK_TRIGGERING_SOURCE,
  phase9BudgetKeyFor,
  phase9Closed,
  phase9ClosureProblems,
  phase9RequiresSoakRerun,
  type Phase9GateResult,
  type Phase9Results,
} from '../src/core/projection/phase9.js';
import { PHASE7_SERVER_IDS } from '../src/core/projection/phase7.js';
import { PHASE8_RULES } from '../src/core/projection/phase8.js';
import { RELIABILITY_LOOP_RULES } from '../src/core/projection/reliability-loop.js';
import { USENET_ADMISSION_BOUNDS, SAB_CLIENT_BOUNDS } from '../src/core/usenet/sab-contract.js';

// Projection Phase 9 — the tranche's own rules, offline.
//
// WHAT THIS SUITE IS FOR. The gate needs a real Usenet provider, operator content, Docker, /dev/fuse and
// three real media servers. This runs everywhere in seconds and pins the things a real run cannot check about
// itself:
//
//   * that every threshold is IMPORTED from the closed tranche it claims to come from, so a number cannot be
//     re-derived here and drift from the one the product is built on;
//   * that the two NEW ones are the two the contract names, at the values it names;
//   * that the eleven §5 claims are the document's eleven, in the document's order;
//   * that the PROVIDER-FREE/PROVIDER-REQUIRED split is a partition and that a rehearsal verdict cannot close
//     a provider-required claim — which is the single property that keeps an honest boundary honest;
//   * that a short run, a duplicated verdict, a skip, or a budget a run supplied for itself cannot be read as
//     success.

const h = createHarness('Projection Phase 9 — the tranche rules, offline');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const CONTRACT = 'docs/PROJECTION_PHASE_9_TORBOX_USENET.md';
const COMPOSE = 'docker-compose.projection-phase9.yml';
const REHEARSAL = 'deploy/projection-phase9-rehearsal.sh';
const OPTIONAL = 'deploy/projection-phase9-rehearsal-optional.sh';
const THREE = 'deploy/projection-phase9-rehearsal-three.sh';
const RUNBOOK = 'docs/PROJECTION_PHASE_9_USENET_RUNBOOK.md';

h.section('the eleven claims, and the document they come from');

test('the gate ids are the document\'s eleven claims, numbered in the document\'s own order', () => {
  assertEq(PHASE9_CLOSURE_GATE_IDS.length, 11, 'eleven claims');
  for (let index = 0; index < PHASE9_CLOSURE_GATE_IDS.length; index += 1) {
    const id = PHASE9_CLOSURE_GATE_IDS[index] as string;
    assert(id.startsWith(`P9-${index + 1}-`), `${id} is not numbered ${index + 1}`);
  }
  const document = read(CONTRACT);
  const numbered = document.slice(document.indexOf('## 5. Closure rule'));
  for (let claim = 1; claim <= 11; claim += 1) {
    assert(numbered.includes(`${claim}.`), `the phase document no longer numbers claim ${claim}`);
  }
});

test('every claim has a title, and every title is drawn from the document\'s own words', () => {
  const document = read(CONTRACT).toLowerCase();
  for (const id of PHASE9_CLOSURE_GATE_IDS) {
    const title = PHASE9_GATE_TITLES[id];
    assert(typeof title === 'string' && title.length > 30, `${id} has no title`);
    // A few distinctive words from each title must still be in the document, so a contract edit that changed
    // what a claim MEANS cannot leave this module quietly asserting the old meaning.
    const words = title.toLowerCase().split(/[^a-z]+/).filter((word) => word.length > 6);
    const present = words.filter((word) => document.includes(word)).length;
    assert(present >= Math.min(2, words.length), `${id}'s title no longer matches the phase document`);
  }
});

test('the phase document still forbids the eight things §4 forbids', () => {
  const document = read(CONTRACT);
  const section = document.slice(document.indexOf('## 4. Hard refusals'), document.indexOf('## 5.'));
  const bullets = section.split('\n').filter((line) => line.trim().startsWith('- '));
  assertEq(bullets.length, 8, 'the phase document names eight hard refusals');
});

test('the §6 non-claims are still non-claims, and nothing in this tranche asserts one', () => {
  const document = read(CONTRACT);
  // Whitespace is collapsed first: the document is hard-wrapped, so a non-goal can straddle a line break
  // and a naive includes() would report it missing the moment somebody re-flowed a paragraph.
  const section = document.slice(document.indexOf('## 6. Explicit non-goals')).replace(/\s+/g, ' ');
  for (const nonClaim of PHASE9_NONCLAIMS) {
    assert(section.includes(nonClaim), `the phase document no longer disclaims ${nonClaim}`);
  }
  assert(section.includes('Real-Debrid'), 'Real-Debrid is no longer an explicit non-goal');
  // §4's last hard refusal, checked as source rather than as prose.
  for (const entry of readdirSync(join(repoRoot, 'src/core/usenet'))) {
    const source = read(`src/core/usenet/${entry}`);
    assert(!/RealDebrid|real-debrid/i.test(source) || /claim Real-Debrid support/.test(source),
      `${entry} mentions Real-Debrid outside the hard-refusal list`);
  }
});

h.section('the thresholds');

test('the two NEW thresholds are the two this tranche exists to establish, and both are one', () => {
  assertEq(PHASE9_RULES.SUBMISSIONS_PER_SOURCE_MAX, 1, 'one submission per source');
  assertEq(PHASE9_RULES.ADMISSIONS_PER_JOB_MAX, 1, 'one admission per job');
});

test('every other threshold is IMPORTED rather than re-derived here', () => {
  assertEq(PHASE9_RULES.CONSECUTIVE_FRESH_RUNS, PHASE8_RULES.CONSECUTIVE_FRESH_SOAKS, 'the repetition convention');
  assertEq(PHASE9_RULES.OPERATOR_INTERVENTIONS_MAX, PHASE8_RULES.OPERATOR_INTERVENTIONS_MAX, 'interventions');
  assertEq(PHASE9_RULES.CONSUMER_RESTARTS_MAX, PHASE8_RULES.CONSUMER_RESTARTS_MAX, 'consumer restarts');
  assertEq(PHASE9_RULES.READY_BUDGET_MS, RELIABILITY_LOOP_RULES.READY_BUDGET_MS, 'the readiness budget');
  assertEq(PHASE9_RULES.STABLE_DWELL_MS, USENET_ADMISSION_BOUNDS.STABLE_DWELL_MS, 'the dwell');
  assertEq(PHASE9_RULES.STABLE_SAMPLES, USENET_ADMISSION_BOUNDS.STABLE_SAMPLES, 'the samples');
  assertEq(PHASE9_RULES.REQUEST_TIMEOUT_MS, SAB_CLIENT_BOUNDS.TIMEOUT_MS.default, 'the request timeout');
  assertEq(PHASE9_SERVER_IDS, PHASE7_SERVER_IDS, 'the three media servers are Phase 7\'s own ids');
});

test('only the four measurable claims carry a budget, and each names the right one', () => {
  assertEq(phase9BudgetKeyFor('P9-2-real-job-admitted-once'), 'ADMISSIONS_PER_JOB_MAX', 'admissions');
  assertEq(phase9BudgetKeyFor('P9-6-restart-no-duplicate-no-loss'), 'SUBMISSIONS_PER_SOURCE_MAX', 'submissions');
  assertEq(phase9BudgetKeyFor('P9-10-cleanup-leaves-nothing'), 'RESIDUE_MAX', 'residue');
  assertEq(phase9BudgetKeyFor('P9-11-three-consecutive-fresh-sequences'), 'CONSECUTIVE_FRESH_RUNS', 'sequences');
  for (const id of ['P9-1-offline-boundary-suite', 'P9-4-mixed-manifest', 'P9-5-three-servers-scan-and-read-both']) {
    assertEq(phase9BudgetKeyFor(id), undefined, `${id} must not carry a budget §4 does not give it`);
  }
});

h.section('the provider-free boundary — the most important thing in this file');

test('the provider-free and provider-required sets partition the eleven claims exactly', () => {
  const all = new Set(PHASE9_CLOSURE_GATE_IDS);
  const free = new Set(PHASE9_PROVIDER_FREE_GATE_IDS);
  const required = new Set(PHASE9_PROVIDER_REQUIRED_GATE_IDS);
  assertEq(free.size + required.size, all.size, 'the two sets do not partition the eleven');
  for (const id of PHASE9_CLOSURE_GATE_IDS) {
    assert(free.has(id) !== required.has(id), `${id} is in both sets or in neither`);
  }
});

test('the four claims that need a real provider are the four the document states in those terms', () => {
  assertEq([...PHASE9_PROVIDER_REQUIRED_GATE_IDS].sort().join(' '),
    'P9-11-three-consecutive-fresh-sequences P9-2-real-job-admitted-once '
    + 'P9-3-failed-job-refused-and-absent P9-5-three-servers-scan-and-read-both',
    'a claim moved across the provider boundary; each side of that line is a promise about what was contacted');
});

test('A REHEARSAL VERDICT CANNOT CLOSE A PROVIDER-REQUIRED CLAIM', () => {
  const results = completeRun().results.map((result) => ({ ...result, rehearsal: true }));
  const problems = phase9ClosureProblems({ sequences: [{ index: 1 }, { index: 2 }, { index: 3 }], results });
  for (const id of PHASE9_PROVIDER_REQUIRED_GATE_IDS) {
    assert(problems.some((problem) => problem.includes(id)),
      `${id} was closed by a rehearsal verdict, which would mean the phase could close without a Usenet `
      + 'provider ever being contacted');
  }
});

test('a rehearsal verdict on a provider-FREE claim is accepted, or the rehearsal would be pointless', () => {
  const results = completeRun().results.map((result) => (
    PHASE9_PROVIDER_FREE_GATE_IDS.includes(result.gate as never) ? { ...result, rehearsal: true } : result
  ));
  assertEq(phase9ClosureProblems({ sequences: [{ index: 1 }, { index: 2 }, { index: 3 }], results }).length, 0,
    'a rehearsal verdict on a provider-free claim was refused');
});

test('the operator inputs are things only an operator has, and each is an INPUT rather than a task', () => {
  assert(PHASE9_OPERATOR_INPUTS.length >= 6, 'the input list is not a token gesture');
  const text = PHASE9_OPERATOR_INPUTS.join(' | ');
  assert(/SABnzbd/.test(text), 'the worker');
  assert(/API key/i.test(text), 'the credential');
  assert(/NNTP/.test(text), 'the provider');
  assert(/legally entitled/.test(text), 'the content, stated honestly');
  assert(/expects to FAIL/.test(text), '§5.3 needs a job that fails, and an operator has to choose it');
  assert(/TorBox/.test(text), '§5.4 needs a TorBox entry');
});

h.section('closure, driven rather than read');

const passing = (gate: string, measured?: number, budget?: number): Phase9GateResult => ({
  gate, verdict: 'pass', ...(measured === undefined ? {} : { measured, budget }),
});

function completeRun(): Phase9Results {
  const results: Phase9GateResult[] = [];
  for (const id of PHASE9_CLOSURE_GATE_IDS) {
    const key = phase9BudgetKeyFor(id);
    if (key === undefined) { results.push(passing(id)); continue; }
    results.push(passing(id, PHASE9_RULES[key], PHASE9_RULES[key]));
  }
  return { sequences: [{ index: 1 }, { index: 2 }, { index: 3 }], results };
}

test('a complete run closes', () => {
  const problems = phase9ClosureProblems(completeRun());
  assertEq(problems.length, 0, `a complete run did not close: ${problems.join('; ')}`);
  assert(phase9Closed(completeRun()), 'phase9Closed disagrees with its own problem list');
});

test('a run short of three sequences closes nothing', () => {
  const run = completeRun();
  const problems = phase9ClosureProblems({ ...run, sequences: [{ index: 1 }, { index: 2 }] });
  assert(problems.some((problem) => problem.includes('2 fresh sequences')), problems.join('; '));
});

test('sequences that are not numbered from one without a gap are refused', () => {
  const run = completeRun();
  const problems = phase9ClosureProblems({ ...run, sequences: [{ index: 1 }, { index: 3 }, { index: 4 }] });
  assert(problems.some((problem) => problem.includes('numbered from one')), problems.join('; '));
});

test('a missing verdict is not a pass', () => {
  const run = completeRun();
  const problems = phase9ClosureProblems({ ...run, results: run.results.slice(1) });
  assert(problems.some((problem) => problem.includes('has no verdict')), problems.join('; '));
});

test('a SKIP is not a pass, and it says so by name', () => {
  const run = completeRun();
  const results = run.results.map((result, index) => (index === 0 ? { ...result, verdict: 'skip' as const } : result));
  const problems = phase9ClosureProblems({ ...run, results });
  assert(problems.some((problem) => problem.includes('skipped')), problems.join('; '));
});

test('a DUPLICATED verdict is a refusal rather than a confirmation', () => {
  const run = completeRun();
  const first = run.results[0] as Phase9GateResult;
  const problems = phase9ClosureProblems({ ...run, results: [...run.results, first] });
  assert(problems.some((problem) => problem.includes('more than one verdict')), problems.join('; '));
});

test('a verdict for a claim §5 does not name is refused', () => {
  const run = completeRun();
  const problems = phase9ClosureProblems({ ...run, results: [...run.results, passing('P9-12-invented')] });
  assert(problems.some((problem) => problem.includes('P9-12-invented')), problems.join('; '));
});

test('a run that supplied its OWN budget is refused', () => {
  const run = completeRun();
  const results = run.results.map((result) => (result.gate === 'P9-6-restart-no-duplicate-no-loss'
    ? { ...result, measured: 5, budget: 5 } : result));
  const problems = phase9ClosureProblems({ ...run, results });
  assert(problems.some((problem) => problem.includes('rather than against the')), problems.join('; '));
});

test('a measured value outside its budget is refused, in the right direction for each kind', () => {
  const run = completeRun();
  const ceiling = run.results.map((result) => (result.gate === 'P9-2-real-job-admitted-once'
    ? { ...result, measured: 2 } : result));
  assert(phase9ClosureProblems({ ...run, results: ceiling })
    .some((problem) => problem.includes('reporting 2')), 'two admissions of one job passed');

  const floor = run.results.map((result) => (result.gate === 'P9-11-three-consecutive-fresh-sequences'
    ? { ...result, measured: 1 } : result));
  assert(phase9ClosureProblems({ ...run, results: floor })
    .some((problem) => problem.includes('reporting 1')), 'one sequence out of three passed');
});

test('a pass with no measurement where a budget exists is refused', () => {
  const run = completeRun();
  const results = run.results.map((result) => (result.gate === 'P9-10-cleanup-leaves-nothing'
    ? { gate: result.gate, verdict: 'pass' as const, budget: PHASE9_RULES.RESIDUE_MAX } : result));
  assert(phase9ClosureProblems({ ...run, results })
    .some((problem) => problem.includes('without recording what it measured')), 'a measurement-free pass');
});

test('a measurement where §4 gives no budget is refused', () => {
  const run = completeRun();
  const results = run.results.map((result) => (result.gate === 'P9-4-mixed-manifest'
    ? { ...result, measured: 1, budget: 1 } : result));
  assert(phase9ClosureProblems({ ...run, results })
    .some((problem) => problem.includes('a budget §4 does not give it')), 'an invented budget');
});

h.section('the soak re-run rule');

test('a Phase 9 change that touches only this tranche does NOT re-open the Phase 8 soak', () => {
  assert(!phase9RequiresSoakRerun([
    'src/core/usenet/sab-client.ts',
    'src/core/usenet/admission.ts',
    'src/ops/usenet-command.ts',
    'docker-compose.projection-usenet.yml',
    'test/usenet-admission.ts',
  ]), 'a provider/control-plane-only change re-opened the six-hour soak');
});

test('a change to shared projection mount, recovery, cache or operator-command source DOES re-open it', () => {
  for (const path of PHASE9_SOAK_TRIGGERING_SOURCE) {
    assert(phase9RequiresSoakRerun([path]), `${path} does not re-open the soak, and §5's last paragraph says it should`);
  }
  assert(phase9RequiresSoakRerun(['src\\core\\projection\\reliability-loop.ts']),
    'a Windows-shaped path does not re-open the soak, so the rule would depend on which machine ran the check');
});

test('the trigger list names the shared source the soak is a statement about, and nothing arbitrary', () => {
  for (const path of PHASE9_SOAK_TRIGGERING_SOURCE) {
    assert(/^(src\/core\/projection\/|deploy\/|docker-compose\.)/.test(path), `${path} is not shared projection source`);
  }
  assert(PHASE9_SOAK_TRIGGERING_SOURCE.includes('src/core/projection/reliability-loop.ts'), 'recovery');
  assert(PHASE9_SOAK_TRIGGERING_SOURCE.includes('deploy/projection-alpha.sh'), 'the operator command');
  assert(PHASE9_SOAK_TRIGGERING_SOURCE.includes('docker-compose.projection-alpha.yml'), 'the deployed profile');
});

h.section('the compose file and its port');

test('the rehearsal port collides with no other compose file, and the project is its own', () => {
  const compose = read(COMPOSE);
  const match = /:-(\d{4})\}:5432/.exec(compose);
  assert(match !== null, 'the compose file publishes no recognisable PostgreSQL port');
  const port = match[1] as string;
  assertEq(port, '5660', 'the Phase 9 port');
  assert(compose.includes('name: projection-phase9-gate'), 'the compose project is not its own');
  const others: string[] = [];
  for (const entry of readdirSync(repoRoot)) {
    if (!entry.startsWith('docker-compose.') || entry === COMPOSE) continue;
    if (new RegExp(`[":-]${port}(["}:]|$)`, 'm').test(read(entry))) others.push(entry);
  }
  assertEq(others.length, 0, `port ${port} is also claimed by ${others.join(', ')}`);
});

test('the deployable Usenet profile holds no credential value and cannot be given one', () => {
  const compose = read('docker-compose.projection-usenet.yml');
  assert(!/API_?KEY[^_]*[:=]\s*\S/i.test(compose.replace(/^#.*$/gm, '')),
    'the Usenet profile has a variable that could hold an API key');
  assert(!/NNTP|nntp_(user|pass)|password/i.test(compose.replace(/^#.*$/gm, '')),
    'the Usenet profile has a variable that could hold an NNTP credential');
  assert(compose.includes('127.0.0.1:${PROJECTION_USENET_PORT'),
    'the worker API is published beyond loopback, where its key would be in every intermediary\'s access log');
  assert(compose.includes('cap_drop: ["ALL"]'), 'the worker keeps capabilities');
  assert(compose.includes('no-new-privileges:true'), 'the worker can gain privileges');
  // Comments are stripped first: this file DISCUSSES depends_on at length in the argument for why it has none.
  assert(!/depends_on/.test(compose.replace(/^\s*#.*$/gm, '')),
    'the Usenet worker can hold the appliance\'s start-up hostage, which is a Usenet failure with reach into '
    + 'the projection namespace');
});

test('the alpha profile is UNCHANGED by this tranche: the Usenet worker is a separate file', () => {
  const alpha = read('docker-compose.projection-alpha.yml');
  assert(!/sabnzbd|usenet/i.test(alpha),
    'the deployable alpha profile now mentions the Usenet worker; Phase 8 closed on that file and §5\'s last '
    + 'paragraph makes editing it a six-hour soak re-run');
});

h.section('the rehearsal entry points');

test('the rehearsal says what it did not prove, names the four open claims, and cleans up on every path', () => {
  const gate = read(REHEARSAL);
  assert(gate.includes('trap cleanup EXIT'), 'cleanup is not registered before anything is created');
  assert(gate.includes('CLOSES NOTHING'), 'the rehearsal does not say that it closes nothing');
  for (const claim of ['P9-2-real-job-admitted-once', 'P9-3-failed-job-refused-and-absent',
    'P9-5-three-servers-scan-and-read-both', 'P9-11-three-consecutive-fresh-sequences']) {
    assert(gate.includes(claim), `the rehearsal does not check that ${claim} was named as still open`);
  }
  assert(gate.includes('exit "$GATE_SKIP_STATUS"'), 'a skip is folded into something other than a skip');
});

test('the optional wrapper says NOTHING WAS PROVED and is not the closing command', () => {
  const optional = read(OPTIONAL);
  assert(/NOTHING WAS PROVED/.test(optional), 'the optional wrapper does not say that a skip proves nothing');
  assert(/does not fold an\s*# open phase into a closed one|does not fold an open phase/.test(optional),
    'the optional wrapper does not distinguish folding a SKIP from folding an open phase');
});

test('the three-runner counts, refuses to announce a sequence it did not complete, and propagates 77', () => {
  const three = read(THREE);
  assert(three.includes('completed=$((completed + 1))'), 'runs are not counted');
  assert(three.includes('refusing to report a completed sequence'), 'a zero-run loop could announce success');
  assert(three.includes('exit "$GATE_SKIP_STATUS"'), 'a skip is folded into something other than a skip');
  assert(three.includes('projection-phase9-rehearsal.sh'), 'the runner does not run this rehearsal');
  assert(three.includes('IT CLOSES NO PART OF PHASE 9'),
    'three rehearsals could be read as §5.11, which asks for three runs of the complete MIXED-PROVIDER sequence');
});

h.section('the lifecycle, re-exported so a gate reads it from the phase it closes');

test('the phase module re-exports the worker contract\'s lifecycle rather than restating it', () => {
  assertEq(PHASE9_JOB_STATES.join(' '), 'downloading repairing unpacking ready-to-admit admitted refused', 'states');
});

h.section('the operator runbook');

test('the runbook distinguishes all six states and says what an operator does about each', () => {
  const runbook = read(RUNBOOK);
  for (const state of PHASE9_JOB_STATES) {
    assert(runbook.includes(`\`${state}\``), `the runbook does not name the ${state} state`);
  }
});

test('the runbook names the four claims that still need a provider, and says only the operator can run them', () => {
  const runbook = read(RUNBOOK);
  for (const claim of ['§5.2', '§5.3', '§5.5', '§5.11']) {
    assert(runbook.includes(claim), `the runbook does not say that ${claim} still needs a provider`);
  }
  assert(/NEEDS A PROVIDER/.test(runbook), 'the runbook does not mark the steps that need a provider');
  assert(/PROVIDER-FREE READY/.test(runbook), 'the runbook does not state its own honest status');
});

test('the runbook restates the eight hard refusals and never suggests working around one', () => {
  const runbook = read(RUNBOOK).replace(/\s+/g, ' ');
  const contract = read(CONTRACT);
  const section = contract.slice(contract.indexOf('## 4. Hard refusals'), contract.indexOf('## 5.'));
  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('- ')) continue;
    // The document's bullets are one sentence broken across list items, so they end in `;`, `; or` or `.`.
    // Those are punctuation, not part of the rule, and the runbook is free to punctuate its own list.
    const rule = line.trim().slice(2).replace(/(;\s*or|[;.])$/, '').trim().replace(/\s+/g, ' ');
    assert(runbook.includes(rule), `the runbook does not restate the hard refusal "${rule}"`);
  }
});

test('the runbook exposes no credential, no URL and no host-specific secret path', () => {
  const runbook = read(RUNBOOK);
  assert(!/apikey=[A-Za-z0-9]{8,}/.test(runbook), 'the runbook shows a real-looking key in a URL');
  assert(runbook.includes('<the api key>'), 'the runbook does not use a placeholder for the key');
  assert(runbook.includes('shred -u') || runbook.includes('rm -f'),
    'the runbook does not tell an operator to remove the file holding their indexer URL');
});

test('the runbook tells an operator where the ledger may NOT live, which is a real trap', () => {
  const runbook = read(RUNBOOK);
  assert(/swept at daemon startup|cache directory/.test(runbook),
    'the runbook does not warn that the daemon cache directory is swept, which would silently reset the '
    + 'exactly-once guarantee');
  assert(/tmpfs/.test(runbook), 'the runbook does not say the state directory must be durable');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase9.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase9.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
