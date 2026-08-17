import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { phase9RequiresSoakRerun } from '../src/core/projection/phase9.js';
import { PHASE11_RULES } from '../src/core/projection/phase11.js';
import {
  PHASE12_AUDIT_GATE_IDS,
  PHASE12_CEILING_SENTENCE,
  PHASE12_CLOSURE_GATE_IDS,
  PHASE12_FORBIDDEN_SOURCE,
  PHASE12_GATE_TITLES,
  PHASE12_HOST_GATE_IDS,
  PHASE12_NONCLAIMS,
  PHASE12_NOT_ON_THE_ROADMAP,
  PHASE12_ROADMAP_PHASES,
  PHASE12_RULES,
  PHASE12_SEQUENCE_GATE_IDS,
  PHASE12_TRANCHE_PATHS,
  PHASE12_UNTOUCHABLE_CLAIMS,
  phase12BudgetKeyFor,
  phase12Closed,
  phase12ClosureProblems,
  phase12SkippedClaims,
  type Phase12GateResult,
} from '../src/core/projection/phase12.js';

// Projection Phase 12 — the tranche's own rules, offline.
//
// WHAT THIS SUITE IS FOR. The same four questions `test/projection-phase11.ts` asks of its own tranche, asked
// of this one: that the claim ids are the document's in the document's order, that a skip cannot become a
// pass, that a run cannot supply its own budget, and that the boundary this tranche drew around itself held.
//
// AND ONE THIS TRANCHE HAS THAT PHASE 11 DID NOT: THE PHASE 10 COMPOSE REPAIR'S CONTROL LIVES HERE. Phase 12
// changed one line of a file Phase 10 owns, and §5.1's `REPAIRS_WITHOUT_A_CONTROL_MAX` is zero — so the
// control for it belongs to the tranche that made the change rather than to the tranche that owns the file,
// which is not this suite's to widen.

const h = createHarness('Projection Phase 12 — the audit and provider-free closure rules');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');
const flat = (relative: string): string => read(relative).replace(/\s+/g, ' ');

const CONTRACT = 'docs/PROJECTION_PHASE_12_AUDIT_AND_PROVIDER_FREE_CLOSURE.md';
const STAGE = 'deploy/projection-phase12-stage.sh';

/** A complete, honest run: eleven passes, three sequences, every budget the contract's own. */
function honestRun(): { sequences: { index: number }[]; results: Phase12GateResult[] } {
  return {
    sequences: [{ index: 1 }, { index: 2 }, { index: 3 }],
    results: PHASE12_CLOSURE_GATE_IDS.map((gate): Phase12GateResult => {
      const key = phase12BudgetKeyFor(gate);
      if (key === undefined) return { gate, verdict: 'pass' };
      const budget = PHASE12_RULES[key];
      return { gate, verdict: 'pass', measured: budget, budget };
    }),
  };
}

h.section('the eleven claims, and the document they come from');

test('the gate ids are the document\'s eleven claims, in the document\'s own order', () => {
  assertEq(PHASE12_CLOSURE_GATE_IDS.length, 11, 'the contract states eleven claims');
  const contract = read(CONTRACT);
  let cursor = -1;
  for (const id of PHASE12_CLOSURE_GATE_IDS) {
    const number = id.slice(0, id.indexOf('-', 4));
    const at = contract.indexOf(`**${number}**`);
    assert(at > cursor, `${number} is missing from §5 or is out of the document's order`);
    cursor = at;
  }
});

test('the three tiers are a partition of the eleven, with nothing in two of them', () => {
  const all = [...PHASE12_AUDIT_GATE_IDS, ...PHASE12_HOST_GATE_IDS, ...PHASE12_SEQUENCE_GATE_IDS];
  assertEq(all.length, PHASE12_CLOSURE_GATE_IDS.length, 'the tiers do not add up to the eleven');
  assertEq(new Set(all).size, all.length, 'a claim appears in two tiers');
  for (const id of PHASE12_CLOSURE_GATE_IDS) assert(all.includes(id), `${id} is in no tier`);
});

test('every claim has a one-line title, and no title names a path, a URL or an identity', () => {
  for (const id of PHASE12_CLOSURE_GATE_IDS) {
    const title = PHASE12_GATE_TITLES[id];
    assert(typeof title === 'string' && title.length > 0, `${id} has no title`);
    assert(!/[a-z][a-z0-9+.-]*:\/\/|\/mnt\/|[A-Za-z]:\\/.test(title), `${id}'s title names a path or a URL`);
  }
});

h.section('the thresholds');

test('every imported threshold is the value the tranche it came from holds, read from that module', () => {
  assertEq(PHASE12_RULES.CONSECUTIVE_FRESH_RUNS, PHASE11_RULES.CONSECUTIVE_FRESH_RUNS, 'fresh runs');
  assertEq(PHASE12_RULES.RESIDUE_MAX, PHASE11_RULES.RESIDUE_MAX, 'residue');
  // THE HOST RESIDUE IS THE SAME NUMBER UNDER A NAME THAT SAYS WHAT IT IS COUNTED OVER, and asserting the
  // equality here is what stops the two drifting into two different budgets for one property.
  assertEq(PHASE12_RULES.HOST_RESIDUE_MAX, PHASE11_RULES.RESIDUE_MAX, 'host residue');
  assertEq(PHASE12_RULES.CONSECUTIVE_FRESH_RUNS, 3, 'the fresh-run floor has moved');
});

test('the four NEW thresholds are the four §5.4 names, and every one of them is ZERO', () => {
  for (const key of ['REPAIRS_WITHOUT_A_CONTROL_MAX', 'CONTRACT_TERMS_MOVED_MAX',
    'STAGED_FILES_DIFFERING_MAX', 'SKIPPED_CLAIMS_MAX'] as const) {
    assertEq(PHASE12_RULES[key], 0, `${key} is not zero`);
    assert(read(CONTRACT).includes(`\`${key}\``), `§5.4 does not name ${key}`);
  }
});

test('exactly five claims carry a number, and every one of them is a §5.4 name', () => {
  const measured = PHASE12_CLOSURE_GATE_IDS.filter((id) => phase12BudgetKeyFor(id) !== undefined);
  assertEq(measured.length, 5, 'the set of measured claims has changed size');
  for (const id of measured) {
    const key = phase12BudgetKeyFor(id);
    assert(key !== undefined && key in PHASE12_RULES, `${id} is measured against a threshold §5.4 does not hold`);
  }
});

h.section('closure — a skip is not a pass, and 77 is a skip');

test('a complete, honest run closes', () => {
  assertEq(phase12ClosureProblems(honestRun()).join('\n'), '', 'an honest run was refused');
  assertEq(phase12Closed(honestRun()), true, 'an honest run did not close');
});

test('A SKIPPED CLAIM IS NEVER FOLDED INTO A PASS, and the count is a FUNCTION over the run', () => {
  // THE REFUSAL THIS TRANCHE IS BUILT AROUND. Every gate in this repository can answer 77 and every wrapper
  // can fold one, so this is the number the campaign is likeliest to be tempted by.
  const run = honestRun();
  run.results = run.results.map((one) =>
    one.gate === 'P12-R2-phase11-mixed-gate-reached-all-six-arms-on-the-real-host'
      ? { gate: one.gate, verdict: 'skip' as const } : one);
  assertEq(phase12SkippedClaims(run).length, 1, 'the skip was not counted');
  const problems = phase12ClosureProblems(run);
  assert(problems.some((one) => /1 claim\(s\) were SKIPPED/.test(one)), 'the skip count is not reported');
  assert(problems.some((one) => /a skip proves nothing and is never folded into a pass/.test(one)),
    'the skipped claim itself was not refused');
  assertEq(phase12Closed(run), false, 'a run with a skip in it closed');
  // AND THE COUNTER IS DERIVED. A constant would report zero for the run above, which is Phase 10's own audit
  // defect #7 exactly.
  assertEq(phase12SkippedClaims(honestRun()).length, 0, 'an honest run reports a skip it did not have');
});

test('a short run, a missing verdict and a duplicated verdict are each refused', () => {
  const short = honestRun();
  short.sequences = [{ index: 1 }];
  assert(phase12ClosureProblems(short).some((one) => /requires 3/.test(one)), 'a one-sequence run closed');

  const gapped = honestRun();
  gapped.sequences = [{ index: 1 }, { index: 3 }, { index: 4 }];
  assert(gapped.sequences.length === 3
    && phase12ClosureProblems(gapped).some((one) => /numbered from one without a gap/.test(one)),
  'three sequences numbered 1, 3, 4 were accepted as three consecutive ones');

  const missing = honestRun();
  missing.results = missing.results.slice(1);
  assert(phase12ClosureProblems(missing).some((one) => /an absent verdict is not a pass/.test(one)),
    'a claim with no verdict at all was accepted');

  const duplicated = honestRun();
  duplicated.results = [...duplicated.results, duplicated.results[0] as Phase12GateResult];
  assert(phase12ClosureProblems(duplicated).some((one) => /more than one verdict/.test(one)),
    'one claim carrying two verdicts was accepted');

  const invented = honestRun();
  invented.results = [...invented.results, { gate: 'P12-Z9-invented', verdict: 'pass' }];
  assert(phase12ClosureProblems(invented).some((one) => /which §5 does not name/.test(one)),
    'a verdict for a claim the contract does not name was accepted');
});

test('a run cannot supply its own budget, nor pass while exceeding the contract\'s', () => {
  const ownBudget = honestRun();
  ownBudget.results = ownBudget.results.map((one) =>
    one.gate === 'P12-P2-candidate-staged-byte-identical-both-ways'
      ? { ...one, measured: 9, budget: 9 } : one);
  assert(phase12ClosureProblems(ownBudget).some((one) => /rather than against the contract's 0/.test(one)),
    'a run that brought its own budget was accepted');

  const exceeded = honestRun();
  exceeded.results = exceeded.results.map((one) =>
    one.gate === 'P12-C1-host-left-as-it-was-found' ? { ...one, measured: 2 } : one);
  assert(phase12ClosureProblems(exceeded).some((one) => /passed while reporting 2 against a budget of 0/.test(one)),
    'a run reporting two pieces of residue against a budget of zero was accepted');

  const floor = honestRun();
  floor.results = floor.results.map((one) =>
    one.gate === 'P12-R3-both-three-run-wrappers-fresh-and-unskipped' ? { ...one, measured: 2 } : one);
  assert(phase12ClosureProblems(floor).some((one) => /passed while reporting 2 against a budget of 3/.test(one)),
    'two of three fresh runs satisfied a floor of three');

  const unmeasured = honestRun();
  unmeasured.results = unmeasured.results.map((one) =>
    one.gate === 'P12-A1-every-in-scope-defect-repaired-with-a-control'
      ? { gate: one.gate, verdict: 'pass' as const, budget: 0 } : one);
  assert(phase12ClosureProblems(unmeasured).some((one) => /passed without recording what it measured/.test(one)),
    'a measured claim passed without a measurement');
});

test('a claim with no budget cannot report a measurement it invented', () => {
  const invented = honestRun();
  invented.results = invented.results.map((one) =>
    one.gate === 'P12-A2-every-defect-recorded-repaired-or-not' ? { ...one, measured: 0, budget: 0 } : one);
  assert(phase12ClosureProblems(invented).some((one) => /a budget §5.4 does not give it/.test(one)),
    'a pass/fail claim reported a measurement against a budget the contract never set');
});

h.section('§4 — the refusals that are checkable');

test('this tranche does NOT re-open the Phase 8 soak, asserted by running the contract\'s own function', () => {
  assertEq(phase9RequiresSoakRerun(PHASE12_TRANCHE_PATHS), false,
    'a path this tranche touches is on PHASE9_SOAK_TRIGGERING_SOURCE, which re-opens three consecutive soaks');
});

test('THIS TRANCHE SHIPS NO PRODUCT SOURCE, and the files it touches outside its own are exactly §6.2\'s', () => {
  for (const path of PHASE12_TRANCHE_PATHS) {
    if (!path.startsWith('src/')) continue;
    assertEq(path, 'src/core/projection/phase12.ts',
      `${path} is product source and §3.1 says this tranche ships none`);
  }
  // LISTED RATHER THAN FILTERED, which is the lesson Phase 11 §10.5's tenth defect records: a boundary that
  // excludes a directory before comparing is a boundary that passes vacuously the moment somebody edits one.
  const own = new Set([CONTRACT, 'src/core/projection/phase12.ts', STAGE, 'test/projection-phase12.ts']);
  const foreign = PHASE12_TRANCHE_PATHS.filter((path) => !own.has(path));
  assertEq([...foreign].sort().join('\n'), [
    'deploy/projection-phase11-mixed-gate.sh',
    'docker-compose.projection-phase10.yml',
    'docker-compose.projection-phase11.yml',
    'docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md',
    'docs/PROJECTION_PHASE_11_MIXED_SOURCE_ACCEPTANCE.md',
    'package.json',
    'test/projection-phase11-gate-audit.ts',
    'test/projection-phase11.ts',
    'test/suite-inventory.json',
  ].join('\n'), 'this tranche touches a file outside its own set that §6.2 does not list');
});

test('every path the tranche claims to touch exists, so the list cannot go quietly stale', () => {
  for (const path of PHASE12_TRANCHE_PATHS) {
    assert(existsSync(join(repoRoot, path)), `${path} is on the tranche's own path list and is not in the tree`);
  }
});

test('the forbidden source is still there, is not on the tranche\'s own list, and §6.3 names it', () => {
  const contract = read(CONTRACT);
  for (const path of PHASE12_FORBIDDEN_SOURCE) {
    assert(existsSync(join(repoRoot, path)), `${path} is forbidden to modify and has gone missing`);
    assert(!PHASE12_TRANCHE_PATHS.includes(path), `${path} is both forbidden and claimed as touched`);
    assert(contract.includes(path), `§6.3 no longer names ${path} as untouchable`);
  }
  // PHASE 11's OWN MODULE IS ON THAT LIST AND IT IS THE LOAD-BEARING ENTRY. Phase 11's rules are what this
  // tranche audits the gate AGAINST; a tranche that could edit both sides of that comparison is a tranche
  // whose audit concludes whatever it needs to.
  assert(PHASE12_FORBIDDEN_SOURCE.includes('src/core/projection/phase11.ts'),
    'the rules this tranche audits the gate against are editable by it');
  // THE FORBIDDEN DOCUMENTS LIVE IN §6.3 RATHER THAN IN THE MODULE, because one of them is a filename that
  // names the provider and the module would then have to widen eight source allowlists for a string.
  assert(contract.includes('docs/PROJECTION_PHASE_9_TORBOX_USENET.md'),
    '§6.3 no longer names the Phase 9 contract as untouchable');
  assert(!read('src/core/projection/phase12.ts').toLowerCase().includes('torbox'),
    'the rules module names the provider, which would require widening eight source allowlists');
});

test('the untouchable claims of earlier tranches are named, and no Phase 12 file records one', () => {
  assertEq(PHASE12_UNTOUCHABLE_CLAIMS.length, 8, 'the untouchable claim list has changed size');
  for (const relative of ['src/core/projection/phase12.ts', STAGE]) {
    const body = read(relative);
    assert(!/VERDICT\s+P9-|VERDICT\s+P10-|VERDICT\s+P11-/.test(body),
      `${relative} records an earlier tranche's verdict, and that tranche's own document is the only place `
      + 'one may be written');
  }
});

test('the ceiling sentence is Phase 11 §8\'s, and both documents still carry it', () => {
  assert(flat('docs/PROJECTION_PHASE_11_MIXED_SOURCE_ACCEPTANCE.md').includes(PHASE12_CEILING_SENTENCE),
    'Phase 11 §8 no longer carries the sentence this tranche is bounded by');
  assert(flat(CONTRACT).includes(PHASE12_CEILING_SENTENCE), '§8 no longer carries the ceiling sentence');
  assert(flat(CONTRACT).includes('It closes nothing about the mixed PRODUCT'),
    '§8 no longer says this tranche closes nothing about the mixed product');
});

test('the contract still states every non-claim, so a summary cannot grow one', () => {
  const contract = flat(CONTRACT).toLowerCase();
  for (const nonclaim of PHASE12_NONCLAIMS) {
    assert(contract.includes(nonclaim.toLowerCase()), `§8 no longer says this tranche is not ${nonclaim}`);
  }
});

h.section('§12 — the roadmap, which is the other half of what this document is for');

test('§12 still states all three later phases, and the one thing that is on none of them', () => {
  const contract = read(CONTRACT);
  for (const phase of PHASE12_ROADMAP_PHASES) {
    assert(contract.includes(phase), `§12 no longer states ${phase}`);
  }
  // THE FAILURE MODE OF A ROADMAP IS NOT THAT IT IS WRONG. It is that a later tranche quietly stops
  // mentioning the row it cannot satisfy, so each row's entry AND exit criteria are pinned by their headings.
  for (const heading of ['**Entry criteria.**', '**Exit criteria.**', '**Claims it may close.**',
    '**Windows required.**', '**Dependencies.**']) {
    assertEq((contract.match(new RegExp(heading.replace(/[*]/g, '\\*'), 'g')) ?? []).length >= 3, true,
      `§12 does not give all three later phases a ${heading} row`);
  }
  assert(contract.includes(`**${PHASE12_NOT_ON_THE_ROADMAP}.** Deferred past Phase 15`),
    `§12.4 no longer says ${PHASE12_NOT_ON_THE_ROADMAP} is deferred past every phase on the roadmap`);
});

test('§12.2 refuses a partial Phase 14 and asks for a preflight instead, and never for a secret value', () => {
  const contract = flat(CONTRACT);
  assert(/PHASE 14 DOES NOT RUN AND DOES NOT PARTIALLY RUN/.test(contract),
    '§12.2 no longer refuses a partial run when the operator inputs are missing');
  assert(/naming the SHAPE of each missing input/.test(contract),
    '§12.2 no longer asks for the shape of a missing input rather than the input');
  assert(/never asks for, prints, transports or records a secret value/.test(contract),
    '§12.2 no longer forbids asking for or printing a secret');
  assert(/An invented success is the one output this phase is forbidden to produce/.test(contract),
    '§12.2 no longer names the output it exists to refuse');
});

test('§12.1 forbids a credential change, an induced outage and an allowlist widening', () => {
  const contract = flat(CONTRACT);
  for (const rule of ['no credential change and no induced provider outage',
    'A run that has to widen it is a Phase 13 blocker, not a Phase 13 step',
    'No credential is read, printed, written to evidence, rotated or changed']) {
    assert(contract.includes(rule), `§12.1 no longer says: ${rule}`);
  }
});

h.section('the repairs this tranche made to files it does not own');

test('PHASE 12 §6.2: the Phase 10 rehearsal database is published on LOOPBACK, not on every interface', () => {
  // THE CONTROL FOR A ONE-LINE REPAIR TO A FILE PHASE 10 OWNS. §5.1's REPAIRS_WITHOUT_A_CONTROL_MAX is zero,
  // and Phase 10's own suite is not this tranche's to widen — so the control belongs to the tranche that made
  // the change. Phase 12 runs this rehearsal on the operator's own Unraid host, where `5670:5432` published
  // `postgres`/`postgres` on every address of that host for the life of the run. The rehearsal has always
  // connected at `127.0.0.1:5670`, so the narrowing costs the run nothing.
  const compose = read('docker-compose.projection-phase10.yml');
  assert(/- "127\.0\.0\.1:\$\{PROJECTION_PHASE10_GATE_PG_PORT:-\d{4}\}:5432"/.test(compose),
    'the Phase 10 rehearsal database is published on every interface of whatever host runs it');
  assert(/127\.0\.0\.1:\$\{PG_PORT\}\/catalog/.test(read('deploy/projection-phase10-rehearsal.sh')),
    'the rehearsal no longer reaches its database on loopback, so the binding above would break it');
  // AND NOTHING ELSE OF PHASE 10's COMPOSE FILE MOVED. §6.2 says one line; this is what says one line.
  assertEq(Number(/:-(\d{4})\}:5432/.exec(compose)?.[1]), 5670, 'the Phase 10 port moved');
  assert(/tmpfs/.test(compose) && /postgres:16@sha256:/.test(compose),
    'the throwaway storage or the pinned image moved, and §6.2 authorised neither');
});

h.section('the staging command — read-only until a caller types otherwise');

test('preflight is the DEFAULT mode and it writes nothing to the host', () => {
  const code = read(STAGE).replace(/^\s*#.*$/gm, '');
  assert(/^MODE="preflight"$/m.test(code), 'the default mode is not the read-only one');
  // THE PREFLIGHT FUNCTION'S OWN BODY, and every command in it must be a read. A staging run that discovers
  // the host cannot host the gates has already written to the host.
  const from = code.indexOf('preflight() {');
  const to = code.indexOf('\n}\n', from);
  assert(from > 0 && to > from, 'the preflight function could not be located');
  const body = code.slice(from, to);
  // THE VERBS ARE LISTED RATHER THAN THE PREFIXES, and the distinction is real: `docker compose version` is
  // a read and `docker compose up` is not, so a check that refused the prefix would refuse the preflight for
  // asking the host which Compose it has.
  for (const write of ['rm -rf', 'mkdir', 'tar -x', '>>', 'docker rm', 'docker stop', 'docker start',
    'docker compose up', 'docker compose down', 'docker compose restart', 'docker network create',
    'docker volume create', 'docker pull', 'systemctl']) {
    assert(!body.includes(write), `the read-only preflight contains '${write}', which writes to the host`);
  }
  // THE TWO PROBES THAT START A THROWAWAY CONTAINER ARE BEHIND A FLAG AND SAY SO, because "read-only" that
  // quietly starts a container is a word doing work it has not earned.
  assert(/if \[ "\$FULL" -eq 1 \]/.test(body), 'the container probes are not behind the --full flag');
  assert(body.includes('the two container probes were NOT run'),
    'a preflight without --full does not say which questions it did not ask');
});

test('the staging directory is GUARDED by a marker, and the guard is why it may be cleared at all', () => {
  const code = read(STAGE).replace(/^\s*#.*$/gm, '');
  assert(/STAGE_MARKER="catalog-phase12-"/.test(code), 'the staging directory has no marker to be guarded by');
  assert(/case "\$\(basename "\$STAGE_DIR"\)" in/.test(code), 'the marker is not checked against the basename');
  for (const guard of ['*..*', 'must be an absolute path']) {
    assert(code.includes(guard), `the staging directory is not guarded against: ${guard}`);
  }
  // AND THE CLEAR IS ONLY REACHABLE THROUGH THAT GUARD. A script that takes a path and empties it is one bad
  // variable away from emptying something else.
  const stageAt = code.indexOf('stage() {');
  const stageEnd = code.indexOf('\n}\n', stageAt);
  const body = code.slice(stageAt, stageEnd);
  assert(body.indexOf('require_stage_dir') < body.indexOf('rm -rf'),
    'the staging directory is cleared before the guard that says it may be');
});

test('byte identity is proved in BOTH directions, against an archive rather than the working tree', () => {
  const body = read(STAGE);
  const code = body.replace(/^\s*#.*$/gm, '');
  assert(/git archive --format=tar "\$COMMIT"/.test(code), 'the candidate is not archived from one commit');
  assert(/LC_ALL=C sort/.test(code), 'the manifests are not sorted under the C locale, so collation is drift');
  assert(/sed 's\/ \\\*\/  \/'/.test(code), 'the binary marker is not normalised, so the hashes differ for no reason');
  assert(/differing="\$\(diff "\$local_manifest" "\$host_manifest" \| grep -c '\^\[<>\]'\)"/.test(code),
    'the comparison is not a two-sided diff, so a file present on only one side could pass');
  assert(body.includes('.gitattributes'),
    'the script does not record WHY the comparison is against an archive, which is the reason it looks odd');
  assert(/node_modules/.test(code), 'the host manifest does not exclude what running produces rather than staging');
});

test('the staging command holds no secret, guesses no host, and hangs on nothing', () => {
  const code = read(STAGE).replace(/^\s*#.*$/gm, '');
  assert(/HOST="\$\{PROJECTION_PHASE12_HOST:-\}"/.test(code), 'the target host is defaulted rather than required');
  assert(!/PROJECTION_PHASE12_HOST:-[a-z]/.test(code), 'the script guesses which machine a command lands on');
  assert(/-o BatchMode=yes -o ConnectTimeout=15/.test(code),
    'the connection can prompt or wait forever, and a hang is worse than a failure');
  for (const secret of ['password', 'api_key', 'apikey', 'PRIVATE KEY', 'token=']) {
    assert(!code.toLowerCase().includes(secret.toLowerCase()), `the staging command mentions ${secret}`);
  }
  assert(/exit "\$GATE_SKIP_STATUS"/.test(code) && /GATE_SKIP_STATUS=77/.test(code),
    'the script cannot say 77, so a host it cannot reach would read as a failure of the product');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase12.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase12.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

test('every Phase 12 script is reachable from a named npm script', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  for (const name of ['go:phase12-stage', 'test:phase12']) {
    assert(name in scripts, `${name} is not an npm script, so nobody can run it the documented way`);
  }
});

await h.finish();
