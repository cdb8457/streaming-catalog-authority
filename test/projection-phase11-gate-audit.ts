import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { NO_SHELL, posixShell, shPath, shellOrThrow } from './posix-shell-kit.js';
import {
  PHASE11_ARM_GATE_IDS,
  PHASE11_CLOSURE_GATE_IDS,
  PHASE11_FAKE_EMITTABLE_GATE_IDS,
  PHASE11_SEQUENCE_LEVEL_GATE_IDS,
  PHASE11_TIER_TWO_GATE_IDS,
} from '../src/core/projection/phase11.js';

// Projection Phase 11 — the mixed gate audit.
//
// WHAT THIS SUITE EXISTS FOR, AND THE HISTORY BEHIND IT. Phase 8's gate defined a function and never called
// it, so the file every later assertion read was never written, and every cycle failed against a product that
// had done nothing wrong. `bash -n` did not catch it. An id audit did not catch it. Only RUNNING it did, six
// hours in. Phase 11's gate is provider-free and minutes long rather than hours, which lowers the cost of
// that failure and does not change its shape.
//
// SO THE CLASSES OF DEFECT THIS FILE IS AIMED AT ARE THE ONES THAT SURVIVE A SYNTAX CHECK:
//
//   A FUNCTION THAT IS DEFINED AND NEVER CALLED. Pinned by name, both ways.
//   A VARIABLE READ UNDER `set -u` THAT NOTHING EVER SETS.
//   A VERDICT ID THE CLOSURE RULE DOES NOT NAME, or a §5 id the gate claims and may not.
//   AN ARM DECLARED AND NEVER REACHED, which is P11-M6's own subject turned back on the instrument.
//   A WRAPPER THAT RUNS SOMETHING OTHER THAN THE THING IT NAMES. Pinned by DRIVING it against a stub.
//   AN ACCOUNTING LOOP THAT CAN ANNOUNCE A SEQUENCE IT DID NOT COMPLETE. Pinned by driving it.
//
// AND THE ONE THAT IS THIS TRANCHE'S OWN: A FAKE RUN THAT EMITS A TIER-TWO ID. §4's third hard refusal says
// a fake range origin and a fake worker may not claim a real provider, a real NZB or three real media
// servers, and `PHASE11_FAKE_EMITTABLE_GATE_IDS` is that refusal as a list. The multiset check below is the
// only place it is checked against the script that actually runs.
//
// EVERY STRUCTURAL CHECK HAS A CONTROL THAT PROVES THE AUDIT BITES. Phase 8's lesson was not "write an
// audit"; it was that the old pin — strip the suffix, grep for the bare string — was green against a gate
// recording five ids with no suffix at all. An audit nobody has watched fail is an audit nobody should
// believe, so each check below is re-run against a DELIBERATELY BROKEN COPY of the script and asserted to
// fail.
//
// THE SHELL IS CHOSEN BY EXECUTION, NOT BY NAME. `./posix-shell-kit.js` makes each candidate EXECUTE a script
// at the path spelling this suite hands out and keeps the first that can. Started from an ordinary
// PowerShell, bare `bash` on a stock Windows PATH is the WSL launcher, which cannot address a Windows drive
// path in any spelling and answers 127 — the same number these controls assert on. A green figure from one
// terminal and red from another, about the same commit, is not a verdict about the product at all.

const h = createHarness('Projection Phase 11 — the mixed gate audit');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const GATE = 'deploy/projection-phase11-mixed-gate.sh';
const THREE = 'deploy/projection-phase11-mixed-gate-three.sh';
const OPTIONAL = 'deploy/projection-phase11-mixed-gate-optional.sh';

const tmpDirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'phase11-audit-'));
  tmpDirs.push(dir);
  return dir;
};

// ---------------------------------------------------------------------------------------------------------
// The model: what the script defines, what it calls, and what it reads.
// ---------------------------------------------------------------------------------------------------------

/** Comments stripped, so a function NAMED in an explanation is not mistaken for one that is called. */
const codeOf = (body: string): string => body.replace(/^\s*#.*$/gm, '');

/**
 * Code with the two LITERAL BLOCKS these scripts use blanked, as well as comments.
 *
 * WHY IT NAMES THE TWO CONSTRUCTS INSTEAD OF PAIRING QUOTES. A `$NAME` inside single quotes is not expanded
 * by any POSIX shell, so the obvious model is "blank everything between one apostrophe and the next". That
 * model is WRONG on this file and would be wrong on any file written in English: `"the operator's inputs"`
 * and `"§4's third hard refusal"` are apostrophes inside DOUBLE quotes, which are not shell quoting at all,
 * and each one shifts the pairing by one — so a run of prose silently blanks the assignments after it and
 * unblanks the JavaScript before it. Phase 10's audit reported `$MEDIA_ROOT` as unbound in a script that
 * assigns it on its own line, which is exactly the false failure that gets an audit deleted rather than
 * fixed.
 *
 * So the two constructs that really are literal here are named: a `node -e '…'` argument, and a heredoc whose
 * tag is quoted (`<<'TAG'`). Both are places this project deliberately puts a different language, and the
 * variables inside them belong to that language. An UNQUOTED heredoc is deliberately NOT blanked — the shell
 * really does expand it, so a `$NAME` in one is a read this model must see.
 */
const shellCodeOf = (body: string): string => codeOf(body)
  .replace(/-e\s+'[\s\S]*?'/g, "-e ''")
  .replace(/<<'([A-Z_]+)'[\s\S]*?\n\1\n/g, "<<'HEREDOC'\nHEREDOC\n");

function definedFunctions(body: string): readonly string[] {
  return [...codeOf(body).matchAll(/^([a-z_][a-z0-9_]*)\(\)\s*\{/gm)].map((match) => match[1] as string);
}

/**
 * Every function name that appears in a CALL position.
 *
 * DELIBERATELY GENEROUS. A false "it is called" is a defect this audit lets through; a false "it is not
 * called" is a suite that fails on a shape somebody wrote correctly, and that is the failure that gets an
 * audit deleted.
 */
function calledFunctions(body: string, names: readonly string[]): ReadonlySet<string> {
  const code = codeOf(body);
  const called = new Set<string>();
  for (const name of names) {
    const pattern = new RegExp(`(^|[;&|(){}\\n]|\\|\\||&&)\\s*${name}\\b(?!\\s*\\(\\)\\s*\\{)`, 'm');
    // `trap NAME EXIT` IS A CALL, and it is the one that matters most: `cleanup` is the function a gate's
    // whole "leaves nothing behind" claim rests on, and it is never invoked by name anywhere else.
    const trapped = new RegExp(`\\btrap\\s+(['"]?)[^'"\\n]*\\b${name}\\b`, 'm');
    if (pattern.test(code) || trapped.test(code)) called.add(name);
  }
  return called;
}

/** Every `$NAME` / `${NAME…}` the script READS, excluding positional and shell-provided names. */
function readVariables(body: string): readonly string[] {
  const code = shellCodeOf(body);
  const names = new Set<string>();
  for (const match of code.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1] as string;
    if (['PATH', 'HOME', 'PWD', 'IFS', 'BASH_SOURCE', 'FUNCNAME', 'LINENO', 'RANDOM', 'SECONDS', 'UID',
      'HOSTNAME', 'SHELL', 'TMPDIR', 'OSTYPE'].includes(name)) continue;
    names.add(name);
  }
  return [...names];
}

function assignedVariables(body: string): ReadonlySet<string> {
  const code = shellCodeOf(body);
  const names = new Set<string>();
  // EVERY `NAME=` ON THE LINE, not just the first. `local id="$1" outcome="$2"` binds two, and a model that
  // saw only `id` would report `outcome` as unbound in a function that plainly assigns it.
  for (const match of code.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)) names.add(match[1] as string);
  for (const match of code.matchAll(/(?:^|\s)(?:local|declare|readonly|export)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    names.add(match[1] as string);
  }
  // A `for NAME in …` loop binds one WHEREVER IT APPEARS, including inside a command substitution, and
  // `${NAME:-default}` supplies its own.
  for (const match of code.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) names.add(match[1] as string);
  for (const match of code.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):[-=]/g)) names.add(match[1] as string);
  return names;
}

/** Every `verdict <id> <outcome>` call site, as it is written. */
function verdictCallSites(body: string): ReadonlyArray<{ readonly id: string; readonly outcome: string }> {
  return [...codeOf(body).matchAll(/^\s*verdict\s+(P11-[A-Za-z0-9-]+)\s+(\S+)/gm)]
    .map((match) => ({ id: match[1] as string, outcome: match[2] as string }));
}

/** Every `arm <id>` call site — the marker P11-M6's own measurement is derived from. */
function armCallSites(body: string): readonly string[] {
  return [...codeOf(body).matchAll(/^\s*arm\s+(P11-[A-Za-z0-9-]+)/gm)].map((match) => match[1] as string);
}

/**
 * The distinct verdict ids the gate records.
 *
 * TWO CALL SITES FOR ONE ID ARE NOT AUTOMATICALLY A DUPLICATE, and getting that wrong in either direction is
 * how an id audit becomes useless. A step written as an `if` records one id in each arm and exactly one of
 * them runs. `duplicateVerdictIds` distinguishes that legitimate shape from the defect: the SAME outcome
 * twice, or a literal outcome and a variable one mixed for one id.
 */
function recordedVerdictIds(body: string): readonly string[] {
  return [...new Set(verdictCallSites(body).map((site) => site.id))];
}

function duplicateVerdictIds(body: string): readonly string[] {
  const byId = new Map<string, string[]>();
  for (const site of verdictCallSites(body)) {
    byId.set(site.id, [...(byId.get(site.id) ?? []), site.outcome]);
  }
  const duplicates: string[] = [];
  for (const [id, outcomes] of byId) {
    if (outcomes.length === 1) continue;
    const literals = [...outcomes].sort().join(',');
    if (outcomes.length === 2 && literals === 'fail,pass') continue;
    duplicates.push(id);
  }
  return duplicates;
}

/** The audit's own verdict on one script body, as a list of sentences. Empty means nothing is wrong. */
function auditProblems(relative: string, body: string): readonly string[] {
  const problems: string[] = [];
  const defined = definedFunctions(body);
  const called = calledFunctions(body, defined);

  for (const name of defined) {
    if (!called.has(name)) problems.push(`${relative} defines ${name}() and never calls it`);
  }

  const assigned = assignedVariables(body);
  for (const name of readVariables(body)) {
    if (!assigned.has(name)) problems.push(`${relative} reads $${name} under set -u and nothing assigns it`);
  }

  if (relative !== GATE) return problems;

  const recorded = recordedVerdictIds(body);
  if (recorded.length === 0) problems.push(`${relative} records no verdict at all`);
  for (const id of recorded) {
    if (!(PHASE11_CLOSURE_GATE_IDS as readonly string[]).includes(id)) {
      problems.push(`${relative} records ${id}, which §5 does not name`);
    }
    // THE REFUSAL THIS TRANCHE IS BUILT AROUND. A fake range origin and a fake worker say nothing about a
    // real provider, a real NZB or three real pre-attached media servers.
    if ((PHASE11_TIER_TWO_GATE_IDS as readonly string[]).includes(id)) {
      problems.push(`${relative} records ${id}, which is a TIER-TWO claim a fake run may never make`);
    }
    if ((PHASE11_SEQUENCE_LEVEL_GATE_IDS as readonly string[]).includes(id)) {
      problems.push(`${relative} records ${id}, which is a claim about a set of runs one run may not answer`);
    }
  }
  // EXPANDED AGAINST THE CONTRACT AS A MULTISET, not as a subset. A gate that answered five of the six it may
  // answer is a gate whose green run is missing a claim nobody counted.
  for (const id of PHASE11_FAKE_EMITTABLE_GATE_IDS) {
    if (!recorded.includes(id)) problems.push(`${relative} never records ${id}, which it is the instrument for`);
  }
  for (const id of duplicateVerdictIds(body)) {
    problems.push(`${relative} records ${id} twice, so it is not clear which is the run's`);
  }

  // AND THE ARM MARKERS, WHICH ARE A SECOND MULTISET OVER THE SAME SIX. A verdict recorded by an arm that
  // never announced itself would leave P11-M6 measuring a denominator it cannot reach.
  const arms = armCallSites(body);
  for (const id of PHASE11_ARM_GATE_IDS) {
    if (!arms.includes(id)) problems.push(`${relative} never marks ${id} as reached, so P11-M6 cannot count it`);
  }
  for (const id of arms) {
    if (!(PHASE11_ARM_GATE_IDS as readonly string[]).includes(id)) {
      problems.push(`${relative} marks ${id} reached, which §5.4 does not predeclare as an arm`);
    }
  }
  if (new Set(arms).size !== arms.length) {
    problems.push(`${relative} marks one arm reached twice, which raises its own denominator`);
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------------------

h.section('the scripts parse, and the shell that parses them is chosen by execution');

test('all three shipped scripts pass a syntax check', () => {
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  for (const relative of [GATE, THREE, OPTIONAL]) {
    const result = spawnSync(shell, ['-n', shPath(join(repoRoot, relative))], { encoding: 'utf8' });
    assertEq(result.status, 0, `${relative} does not parse: ${result.stderr}`);
  }
});

h.section('the structural audit, over the shipped bytes');

test('nothing is defined and never called, and nothing is read that nothing sets', () => {
  for (const relative of [GATE, THREE, OPTIONAL]) {
    const problems = auditProblems(relative, read(relative));
    assertEq(problems.join(' | '), '', `${relative} did not survive the audit`);
  }
});

test('the gate records exactly the six arms it may answer, and none of the eight it may not', () => {
  const recorded = recordedVerdictIds(read(GATE));
  assertEq([...recorded].sort().join(','), [...PHASE11_FAKE_EMITTABLE_GATE_IDS].sort().join(','),
    'the gate\'s verdict multiset is not the contract\'s fake-emittable set');
});

test('the gate marks exactly the six PREDECLARED arms reached, once each', () => {
  const arms = armCallSites(read(GATE));
  assertEq(arms.length, 6, 'the gate does not mark six arms reached');
  assertEq([...arms].sort().join(','), [...PHASE11_ARM_GATE_IDS].sort().join(','),
    'the arms this gate marks reached are not the six §5.4 predeclares');
});

test('every arm is MARKED REACHED BEFORE its verdict is recorded, because reached is not passed', () => {
  const body = codeOf(read(GATE));
  for (const id of PHASE11_ARM_GATE_IDS) {
    const marked = new RegExp(`^\\s*arm\\s+${id}\\b`, 'm').exec(body)?.index;
    const recorded = new RegExp(`^\\s*verdict\\s+${id}\\b`, 'm').exec(body)?.index;
    assert(marked !== undefined && recorded !== undefined, `${id} is not both marked and recorded`);
    assert((marked as number) < (recorded as number),
      `${id} records its verdict before it marks itself reached, so an arm that died half way through would `
      + 'leave no marker AND no verdict, and P11-M6 would be measuring the wrong absence');
  }
});

test('every verdict the gate records is stamped fake=true', () => {
  const code = codeOf(read(GATE));
  assert(/fake=true/.test(code),
    'the gate emits verdicts that do not say they came from a fake run, and phase11.ts reads that field to '
    + 'refuse a tier-two closure');
  assert(!/fake=false/.test(code), 'the gate can emit a non-fake verdict');
});

test('the gate names all four sequence-level AND all four tier-two claims as still open', () => {
  const body = read(GATE);
  for (const id of [...PHASE11_SEQUENCE_LEVEL_GATE_IDS, ...PHASE11_TIER_TWO_GATE_IDS]) {
    assert(body.includes(id),
      `the gate does not name ${id} as still open, and a run whose output does not list what it did not prove `
      + 'is a run that has quietly started reading as a closure');
  }
  assert(/what is missing is a run rather than a gate/.test(body),
    'the gate does not carry the one sentence Phase 10 §8.1 authorised a tier-one GO to write');
});

test('the gate contacts no real provider and asserts endpoint.json is unmoved', () => {
  // THE FORBIDDEN LIST IS ABOUT CONTACTING A REAL PROVIDER, NOT ABOUT THE WORD. This gate legitimately runs
  // a FAKE range origin and a FAKE SABnzbd, because that is what fake mode IS. What it may not do is name a
  // real endpoint, a real worker host or a production origin allowlist.
  const code = codeOf(read(GATE));
  for (const forbidden of ['torbox.app', 'api.torbox', 'nntp:', 'nntps:', 'real-provider-objects.json',
    'endpoint.json"']) {
    assert(!code.toLowerCase().includes(forbidden),
      `the gate names ${forbidden}, which is a real provider input it may not use`);
  }
  assert(/ENDPOINT_MTIME_BEFORE/.test(code) && /ENDPOINT_MTIME_AFTER/.test(code),
    'the gate does not record endpoint.json\'s mtime before and after, so §4\'s seventh refusal is a promise '
    + 'rather than an assertion');
});

test('the gate SKIPS rather than fails on every host condition it cannot control', () => {
  const body = read(GATE);
  // THE PATH PROBE MUST NOT USE ARGV. Under MSYS a POSIX-looking argument is rewritten on the way to a native
  // binary, so an argv probe passes on exactly the host it exists to catch.
  const pathProbe = body.slice(body.indexOf("<<'PROBE'"), body.indexOf('\nPROBE\n'));
  assert(pathProbe.length > 0 && /readFileSync/.test(pathProbe),
    'the run-directory path probe reads the path from argv, which MSYS rewrites');
  // THE IDENTITY PROBE IS THIS TRANCHE'S OWN, FOUND BY RUNNING THE WORKER DRIVER ON A WINDOWS HOST: lstat
  // reports device 0 and fstat reports the volume serial, so `sameFile` never agrees and the shipped
  // admission proof refuses every completed output as mutated. A fact about the filesystem, not the product.
  const identityProbe = body.slice(body.indexOf("<<'IDENTITY'"), body.indexOf('\nIDENTITY\n'));
  assert(identityProbe.length > 0 && /fstatSync/.test(identityProbe) && /lstatSync/.test(identityProbe),
    'the gate does not check that this host agrees with itself about which file a descriptor is open on');
  for (const condition of ['no /dev/fuse is reachable', 'the docker daemon is not answering',
    'the fake range origin never came up']) {
    assert(body.includes(condition), `the gate does not SKIP on: ${condition}`);
  }
  const skips = (codeOf(body).match(/^\s*(\|\| )?skip /gm) ?? []).length
    + (codeOf(body).match(/\n\s*skip "/g) ?? []).length;
  assert(skips >= 4, `the gate has only ${skips} skip paths, and a red run caused by which machine it was `
    + 'launched on is not a verdict about the product');
});

test('no shipped Phase 11 script passes a MULTI-LINE program to node -e', () => {
  // FOUND BY `test/custody-runtime-closure.ts`, WHICH READS EVERY SHIPPED SCRIPT LINE BY LINE. A multi-line
  // `node -e '` opens a single quote the next line does not close, and a quote a line-based reader cannot
  // close is a quote a human reader cannot close either.
  for (const relative of [GATE, THREE, OPTIONAL]) {
    const code = codeOf(read(relative));
    assert(!/node\s+-e\s+'[^']*\n/.test(code),
      `${relative} passes a multi-line program to node -e, which leaves every line after it unreadable`);
  }
});

test('a FAILED gate does not print the paragraph describing what it proved', () => {
  const code = codeOf(read(GATE));
  const guard = code.indexOf('if [ "$FAIL" -ne 0 ]; then');
  const paragraph = code.indexOf('WHAT THIS PROVED');
  assert(guard > 0, 'nothing guards the closing paragraph on the failure count');
  assert(guard < paragraph,
    'the gate narrates what it proved before it checks whether it passed — the first real execution of Phase '
    + '10\'s rehearsal printed the whole paragraph under "4 passed, 2 failed"');
});

test('the gate compares the host\'s container, network and volume SETS rather than counts', () => {
  const code = codeOf(read(GATE));
  for (const name of ['CONTAINERS_BEFORE', 'NETWORKS_BEFORE', 'VOLUMES_BEFORE']) {
    assert(code.includes(name), `the gate takes no ${name} baseline`);
  }
  // Phase 8 §11's precedent: two containers appearing while two others left is a count that agrees and a host
  // that changed.
  assert(!/docker ps -aq \| wc -l/.test(code), 'the gate compares counts rather than sets');
});

test('the redaction scan knows ANY URI scheme and the whole run directory, not http and the media root', () => {
  const body = read(GATE);
  // THE RUN HANDS THE SHIPPED COMMANDS A DATABASE URL WITH A PASSWORD IN IT on every single invocation, and
  // §4's ninth refusal is about credentials before it is about origins.
  assert(body.includes('[a-z][a-z0-9+.-]*://'),
    'the evidence scan knows only http, and the one URL this run actually handles is not an http one');
  assert(/grep -qF "\$WORK"/.test(body),
    'the evidence scan looks only under one directory, so an absolute manifest path in a preserved file '
    + 'would have passed');
  // AND IT LOOKS FOR THIS RUN'S OWN FAKE SECRETS, which are the values a real run would carry as real ones.
  for (const secret of ['phase11fakeworkerkey', 'phase11-fake-origin-token', 'phase11-object-1']) {
    assert(body.includes(secret), `the evidence scan does not look for ${secret}`);
  }
});

/**
 * The gate's own hand-run range, located the way `sed` locates it: by line-anchored markers.
 *
 * ANCHORED, AND THAT MATTERS. A bare `indexOf` finds the marker inside the derivation's own `sed` expression,
 * several lines EARLIER, and would fold the derivation and its control into the range they measure — which is
 * exactly the reading that would report the shipped script as needing a hand-run command it does not need.
 */
function handRunRange(body: string): string {
  const from = /^# HAND-RUN RANGE BEGIN$/m.exec(body)?.index;
  const to = /^# HAND-RUN RANGE END$/m.exec(body)?.index;
  if (from === undefined || to === undefined || to <= from) return '';
  return body.slice(from, to);
}

const HAND_RUN_SHAPE = /npx tsx|npm run ops:/;
const handRunsIn = (body: string): number =>
  handRunRange(body).split('\n').filter((line) => HAND_RUN_SHAPE.test(line)).length;

test('P11-M5 COUNTS its hand-run commands out of the run rather than declaring the answer', () => {
  const body = read(GATE);
  // THE DEFECT THIS PINS, AND IT IS PHASE 10's OWN AUDIT DEFECT #7. An earlier draft of that tranche wrote
  // `HAND_RUN=0` and then asserted it was zero. No line anywhere in the file could move that variable, so
  // the budget was measured by nothing.
  assert(!/^\s*HAND_RUN=0\b/m.test(body),
    'the hand-run measurement is a constant, so the budget it is compared against cannot be exceeded');
  assert(body.includes(
    `HAND_RUN="$(sed -n '/^# HAND-RUN RANGE BEGIN/,/^# HAND-RUN RANGE END/p' "$0" | grep -cE 'npx tsx|npm run ops:')"`),
  'the derivation is not the one this suite\'s controls model, so the control below proves nothing about it');
  assert(/HAND_RUN_CONTROL/.test(body),
    'nothing proves the counter can count, and a grep that matched nothing for the wrong reason reports the '
    + 'same zero as a range that had none');
  assert(handRunRange(body).length > 0, 'the hand-run range cannot be located by its own markers');
  assertEq(handRunsIn(body), 0, 'the shipped mixed operator path already needs a hand-run command');
  // AND THE RANGE REALLY DOES CONTAIN THE OPERATOR PATH, so a range that had shrunk to nothing would fail
  // rather than report a triumphant zero over an empty string.
  for (const id of ['P11-M1', 'P11-M5']) {
    assert(handRunRange(body).includes(id), `the hand-run range no longer contains ${id}'s section`);
  }
});

test('P11-M4 and P11-M6 both DERIVE their numbers, and both prove their counter counts first', () => {
  const body = read(GATE);
  // P11-M4's number is a field-by-field diff of two captured records, and P11-M6's is the difference between
  // the contract's own arm list and the markers the run wrote. Neither may be a literal.
  assert(!/^\s*M4_MOVED=0\b/m.test(body), 'the cross-source measurement is a constant');
  assert(!/^\s*UNREACHED=0\b/m.test(body), 'the unreached-arm measurement is a constant');
  assert(/FIELD_CONTROL/.test(body), 'nothing proves the field-difference counter can count');
  assert(/ARM_CONTROL/.test(body), 'nothing proves the unreached-arm counter can count');
  // THE DENOMINATOR COMES FROM THE MODULE, NOT FROM A COPY IN THE SCRIPT. A gate carrying its own arm list
  // would be a gate whose denominator could drift from the document's in the direction that makes it pass.
  assert(/PHASE11_ARM_GATE_IDS/.test(body),
    'the gate does not read the contract\'s own arm list, so P11-M6\'s denominator is its own opinion');
  // AND BOTH DIRECTIONS OF THE ARM ACCOUNTING ARE CHECKED, because a run that invented a seventh arm would
  // raise its own denominator and report every arm reached.
  assert(/UNDECLARED/.test(body), 'the gate never checks for an arm the contract did not declare');
});

h.section('THE CONTROLS — each one proves the audit bites');

test('CONTROL: a hand-run command added to the operator path is COUNTED', () => {
  const body = read(GATE);
  const tampered = body.replace('content preflight >"$WORK/preflight.txt"',
    '( cd "$ROOT" && npx tsx src/ops/projection-publish-cli.ts )\ncontent preflight >"$WORK/preflight.txt"');
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  assert(handRunsIn(tampered) >= 1,
    'a hand-run invocation inserted into the operator path was not counted, so a budget of zero would have '
    + 'passed a run that needed one');
});

test('CONTROL: a function defined and never called is CAUGHT', () => {
  const tampered = `${read(GATE)}\nunreachable_helper() {\n  echo "nothing calls me"\n}\n`;
  const problems = auditProblems(GATE, tampered);
  assert(problems.some((problem) => /unreachable_helper\(\) and never calls it/.test(problem)),
    'the audit did not notice a function that is defined and never called — which is defect #11 of Phase 8, '
    + 'the one that cost six hours');
});

test('CONTROL: a variable read under set -u that nothing sets is CAUGHT', () => {
  const body = read(GATE);
  const tampered = body.replace('say "migrated"', 'say "migrated $NEVER_ASSIGNED_ANYWHERE"');
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  const problems = auditProblems(GATE, tampered);
  assert(problems.some((problem) => /\$NEVER_ASSIGNED_ANYWHERE/.test(problem)),
    'the audit did not notice an unbound variable, which under set -u is a dead run');
});

test('CONTROL: a verdict id the contract does not name is CAUGHT', () => {
  const body = read(GATE);
  const tampered = body.replace(
    'verdict P11-M6-arms-reached-cleanup-and-redaction "$M6"', 'verdict P11-M99-invented-claim "$M6"');
  assert(tampered !== body, 'the tamper did not apply');
  const problems = auditProblems(GATE, tampered);
  assert(problems.some((problem) => /P11-M99-invented-claim, which §5 does not name/.test(problem)),
    'the audit accepted an id the closure rule does not name');
});

test('CONTROL: A FAKE RUN CLAIMING A TIER-TWO ID IS CAUGHT — the refusal this tranche exists on', () => {
  const tampered = `${read(GATE)}\nverdict P11-R2-three-servers-scan-and-read-both pass\n`;
  const problems = auditProblems(GATE, tampered);
  assert(problems.some((problem) => /TIER-TWO claim a fake run may never make/.test(problem)),
    'a gate driving a fake range origin and a fake worker claimed three real media servers scanned and read '
    + 'both halves, and the audit let it — which is the single property Phase 10 §8.1 authorised this whole '
    + 'tranche on');
});

test('CONTROL: a gate claiming a SEQUENCE-LEVEL id is CAUGHT', () => {
  const tampered = `${read(GATE)}\nverdict P11-S4-three-consecutive-fresh-sequences pass\n`;
  const problems = auditProblems(GATE, tampered);
  assert(problems.some((problem) => /a claim about a set of runs one run may not answer/.test(problem)),
    'one gate run claimed three consecutive fresh sequences and the audit let it');
});

test('CONTROL: a verdict the gate silently STOPS recording is CAUGHT', () => {
  // The Phase 8 defect in its purest form: fifteen required ids never recorded, and every suite green.
  const body = read(GATE);
  const tampered = body.replace(
    'verdict P11-M4-one-source-failing-disturbs-nothing-of-the-other "$M4"', ': # deliberately not recorded');
  assert(tampered !== body, 'the tamper did not apply');
  const problems = auditProblems(GATE, tampered);
  assert(problems.some((problem) => /never records P11-M4/.test(problem)),
    'the gate stopped recording the arm the tranche is named for and the audit did not notice');
});

test('CONTROL: an arm that stops MARKING ITSELF REACHED is CAUGHT', () => {
  // P11-M6's own subject, turned back on the instrument. An arm whose marker disappeared would make the
  // measured unreached count 1 at run time — but only if the gate still tried to reach it. An arm removed
  // from the script entirely is what this catches, statically, before a run is ever assembled.
  const body = read(GATE);
  const tampered = body.replace('arm P11-M3-publish-does-not-move-the-other-half\n', '');
  assert(tampered !== body, 'the tamper did not apply');
  const problems = auditProblems(GATE, tampered);
  assert(problems.some((problem) => /never marks P11-M3.*as reached/.test(problem)),
    'the gate stopped announcing an arm and the audit did not notice, so P11-M6 would have had a denominator '
    + 'it could not reach and no static check would have said so');
});

test('CONTROL: an arm the contract never declared is CAUGHT, in the other direction', () => {
  const tampered = `${read(GATE)}\narm P11-M7-invented-arm\n`;
  const problems = auditProblems(GATE, tampered);
  assert(problems.some((problem) => /P11-M7-invented-arm reached, which §5.4 does not predeclare/.test(problem)),
    'a gate that invented a seventh arm raised its own denominator and the audit let it');
});

test('CONTROL: one id recorded twice is CAUGHT', () => {
  const tampered = `${read(GATE)}\nverdict P11-M1-mixed-generation-assembled pass\n`;
  const problems = auditProblems(GATE, tampered);
  assert(problems.some((problem) => /twice, so it is not clear which is the run's/.test(problem)),
    'a duplicated verdict read as a confirmation');
});

test('CONTROL: the audit is not vacuous — the shipped gate really does define and call functions', () => {
  const defined = definedFunctions(read(GATE));
  assert(defined.length >= 6, `the gate defines only ${defined.length} functions, so the call-graph model is `
    + 'checking almost nothing and would pass over a script that had lost its helpers');
  for (const name of ['verdict', 'arm', 'skip', 'fail', 'content', 'alpha']) {
    assert(defined.includes(name), `the gate has lost ${name}(), one of the helpers this audit is built around`);
  }
});

h.section('THE WRAPPERS, DRIVEN — not read');

/** A stub that exits with a scripted status, so the wrapper's ACCOUNTING is exercised as behaviour. */
function stubExiting(status: number): string {
  const dir = freshDir();
  const file = join(dir, 'stub.sh');
  writeFileSync(file, `#!/usr/bin/env bash\necho "stub ran"\nexit ${status}\n`);
  try { chmodSync(file, 0o755); } catch { /* the mode is only meaningful where the platform has one */ }
  return file;
}

function runWrapper(relative: string, stub: string, env: Record<string, string> = {}): { status: number; out: string } {
  const shell = shellOrThrow();
  const result = spawnSync(shell, [shPath(join(repoRoot, relative))], {
    encoding: 'utf8',
    env: { ...process.env, PROJECTION_PHASE11_GATE_ENTRYPOINT: shPath(stub), ...env },
  });
  return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

test('the optional wrapper folds a SKIP to zero, and says nothing was proved', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const run = runWrapper(OPTIONAL, stubExiting(77));
  assertEq(run.status, 0, 'a skip was not folded');
  assert(/NOTHING WAS PROVED/.test(run.out), 'the fold did not say that nothing was proved');
  assert(/exactly as open/.test(run.out), 'the fold did not say the phase is exactly as open as it was');
  assert(/in both of its tiers/.test(run.out),
    'the fold did not say BOTH tiers are still open, and a reader of a folded skip is exactly the reader who '
    + 'would otherwise assume the fake tier had been settled');
});

test('the optional wrapper does NOT fold a FAILURE, which is the whole difference', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  assertEq(runWrapper(OPTIONAL, stubExiting(1)).status, 1, 'a gate that RAN AND FAILED was folded to zero');
  assertEq(runWrapper(OPTIONAL, stubExiting(0)).status, 0, 'a passing gate was not passed through');
});

test('the three-run wrapper runs the entry point it names, three times', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const run = runWrapper(THREE, stubExiting(0));
  assertEq(run.status, 0, 'three passing runs did not succeed');
  assertEq((run.out.match(/stub ran/g) ?? []).length, 3, 'the wrapper did not run its entry point three times');
  assert(/3 of 3 consecutive/.test(run.out), 'the wrapper did not announce a completed sequence');
  assert(/IT IS NOT P11-S4/.test(run.out), 'a completed repetition did not say what it still does not close');
});

test('the three-run wrapper STOPS on the first failure, and does not announce a sequence', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const run = runWrapper(THREE, stubExiting(1));
  assertEq(run.status, 1, 'a failing run did not fail the sequence');
  assertEq((run.out.match(/stub ran/g) ?? []).length, 1, 'the wrapper kept going after a failure');
  assert(!/consecutive Phase 11 mixed gates completed/.test(run.out), 'a failed sequence announced completion');
});

test('the three-run wrapper propagates a SKIP as 77 rather than folding it', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const run = runWrapper(THREE, stubExiting(77));
  assertEq(run.status, 77, 'a skipped run was folded into the sequence');
  assert(/THIS SEQUENCE PROVES NOTHING/.test(run.out), 'the skip did not say the sequence proves nothing');
});

test('the three-run wrapper cannot announce a sequence it never ran', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  // A loop that never ran must not be able to announce a completed sequence either. The guard is the COUNT,
  // not having fallen out of the loop.
  const run = runWrapper(THREE, stubExiting(0), { PROJECTION_PHASE11_GATE_RUNS: '0' });
  assert(run.status !== 0, 'a zero-run sequence exited zero');
  assert(!/consecutive Phase 11 mixed gates completed/.test(run.out), 'a zero-run sequence announced completion');
});

h.section('THE EMBEDDED HELPER PROGRAMS, DRIVEN — not read');

/** Extract one heredoc-written helper from the gate and put it somewhere it can be executed. */
function helperFrom(tag: string, filename: string): string {
  const body = read(GATE);
  const start = body.indexOf(`<<'${tag}'\n`);
  const end = body.indexOf(`\n${tag}\n`, start);
  assert(start > 0 && end > start, `the gate no longer writes a ${tag} helper`);
  const program = body.slice(start + `<<'${tag}'\n`.length, end);
  const file = join(freshDir(), filename);
  writeFileSync(file, `${program}\n`);
  return file;
}

const runNode = (file: string, args: readonly string[]): { status: number; out: string } => {
  const result = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' });
  return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
};

test('the field-difference helper counts a moved field, a lost field and an identical record', () => {
  // P11-M4's measurement, DRIVEN. The whole claim rests on this program, and a program nobody has watched
  // return a non-zero is a program whose zero means nothing.
  const helper = helperFrom('FIELDDIFF', 'fielddiff.cjs');
  const dir = freshDir();
  const write = (name: string, value: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const base = write('a.json', { path: 'x', size: 1, locator: 'http-range:vault:ref' });
  assertEq(runNode(helper, [base, write('same.json', { path: 'x', size: 1, locator: 'http-range:vault:ref' })]).out,
    '0', 'two identical records did not compare equal');
  assertEq(runNode(helper, [base, write('moved.json', { path: 'x', size: 2, locator: 'http-range:vault:ref' })]).out,
    '1', 'a moved field was not counted');
  assertEq(runNode(helper, [base, write('lost.json', { path: 'x', size: 1 })]).out, '1',
    'a field present in one record and absent from the other was not counted — an entry that LOST a field '
    + 'has been disturbed as surely as one whose field changed');
  assertEq(runNode(helper, [base, write('empty.json', {})]).out, '3', 'a vanished record reported no movement');
});

test('the unreached-arm helper counts both directions, and an empty run is not a complete one', () => {
  const helper = helperFrom('UNREACHED', 'unreached.cjs');
  const dir = freshDir();
  const write = (name: string, lines: readonly string[]): string => {
    const file = join(dir, name);
    writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };
  const declared = write('declared.txt', [...PHASE11_ARM_GATE_IDS]);
  assertEq(runNode(helper, [declared, write('all.txt', [...PHASE11_ARM_GATE_IDS])]).out, '0 0',
    'a complete run reported an unreached arm');
  assertEq(runNode(helper, [declared, write('none.txt', [])]).out, '6 0',
    'a run that reached nothing reported nothing unreached, which is the Phase 8 defect exactly');
  assertEq(runNode(helper, [declared, write('one.txt', [PHASE11_ARM_GATE_IDS[0]])]).out, '5 0',
    'a run that reached one arm of six was not counted');
  assertEq(runNode(helper, [declared, write('extra.txt', [...PHASE11_ARM_GATE_IDS, 'P11-M7-invented'])]).out, '0 1',
    'a run that invented an arm raised its own denominator and was not counted');
});

test('the entry-record helper REFUSES an absent entry rather than emitting an empty record', () => {
  // THE ONE ANSWER THAT MUST NEVER BE PRODUCIBLE BY THE ENTRY HAVING VANISHED. Two empty records compare
  // equal, so an entry that disappeared under an injected failure would report ZERO disturbed fields — which
  // is P11-M4 passing on exactly the outcome it exists to detect.
  const helper = helperFrom('ENTRY', 'entry.cjs');
  const dir = freshDir();
  const status = join(dir, 'status.json');
  writeFileSync(status, JSON.stringify({ entries: [{ path: 'Movies/One/One.bin', size: 1 }] }));
  const present = runNode(helper, [status, 'Movies/One/One.bin', join(dir, 'out-present.json')]);
  assertEq(present.status, 0, 'a present entry was refused');
  assertEq(JSON.parse(readFileSync(join(dir, 'out-present.json'), 'utf8')).size, 1, 'the record lost a field');
  const absent = runNode(helper, [status, 'Movies/Gone/Gone.bin', join(dir, 'out-absent.json')]);
  assert(absent.status !== 0, 'an absent entry produced a record rather than a refusal');
});

test('the run-directory path probe answers 0 for a resolvable path and 1 for one it cannot resolve', () => {
  // THE PROBE THAT DECIDES A SKIP, DRIVEN. A probe that answered 0 for everything would turn the skip into a
  // run against a directory the shipped commands cannot address, and every verb would then fail with a
  // configuration error that a reader would take for a broken product.
  const helper = helperFrom('PROBE', 'probe.cjs');
  const dir = freshDir();
  const resolvable = join(dir, 'resolvable.txt');
  writeFileSync(resolvable, dir);
  assertEq(runNode(helper, [resolvable]).status, 0, 'the probe refused a path this runtime can resolve');
  const missing = join(dir, 'missing.txt');
  writeFileSync(missing, join(dir, 'no-such-directory-anywhere'));
  assert(runNode(helper, [missing]).status !== 0, 'the probe accepted a path this runtime cannot resolve');
});

test('the file-identity probe answers on THIS host, and its answer is a fact about the filesystem', () => {
  // THE SECOND SKIP PROBE, AND THIS TRANCHE FOUND THE NEED FOR IT BY RUNNING THE WORKER DRIVER. On Windows
  // `lstat().dev` is 0 and `fstat().dev` is the volume serial, so `sameFile` never agrees and the shipped
  // admission proof refuses every completed output as `output-mutated-during-digest`. The probe must
  // therefore ANSWER — non-zero here, zero on the appliance — and a probe that exited zero everywhere would
  // let the gate run into a red that is about the machine rather than about the product.
  const helper = helperFrom('IDENTITY', 'identity.cjs');
  const run = runNode(helper, [join(freshDir(), 'identity.bin')]);
  assert(run.status === 0 || run.status === 1,
    `the identity probe crashed rather than answering (status ${run.status}); a probe that cannot answer is a `
    + 'precondition that cannot skip');
  assertEq(run.out, '', 'the identity probe printed something, and a probe that prints is a probe that leaks');
});

test('the corpus helper writes bytes that are not all one value', () => {
  // A probe window over a constant buffer is a meaningless digest, and a gate whose two halves both digest to
  // the same thing is a gate that cannot tell them apart.
  const helper = helperFrom('FILL', 'fill.cjs');
  const file = join(freshDir(), 'corpus.bin');
  assertEq(runNode(helper, [file, '4096']).status, 0, 'the corpus helper failed');
  const bytes = readFileSync(file);
  assertEq(bytes.length, 4096, 'the corpus is the wrong size');
  assert(new Set(bytes).size > 1, 'the synthesised corpus is all one value');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase11-gate-audit.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase11-gate-audit.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
