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

test('the appliance\'s own output is EXCLUDED from the run-path scan and NOT from the secrets scan', () => {
  // A DECISION RECORDED RATHER THAN A SILENT WEAKENING. `deploy/projection-alpha.sh` is the OPERATOR'S
  // appliance surface: telling somebody where their manifest directory is, is the whole job of `status`.
  // Failing P11-M6 on it would be this tranche asserting a redaction rule against a shipped surface it does
  // not own and §6.3 forbids it to edit. What must NOT happen is those files quietly leaving BOTH scans,
  // because then a credential printed by the appliance would go unlooked-for — so this pins the asymmetry.
  const body = read(GATE);
  const secretsAt = body.indexOf('if grep -qiE "$SECRETS_SHAPE"');
  const runPathAt = body.indexOf('if grep -qF "$WORK"');
  assert(secretsAt > 0 && runPathAt > secretsAt, 'the two scans are no longer ordered secrets-then-run-path');
  const betweenScans = body.slice(secretsAt, runPathAt);
  const beforeScans = body.slice(0, secretsAt);
  for (const alphaLog of ['alpha-preflight.txt', 'alpha-install.txt', 'alpha-start.txt', 'alpha-stop.txt']) {
    assert(betweenScans.includes(alphaLog),
      `${alphaLog} is not excluded from the run-path scan, so P11-M6 would fail on the appliance naming the `
      + 'operator\'s own directories — which is that surface doing its job');
    assert(!beforeScans.includes(`|${alphaLog}`) && !beforeScans.includes(`${alphaLog}|`),
      `${alphaLog} is excluded from the SECRETS scan as well, so a credential the appliance printed would go `
      + 'unlooked-for');
  }
});

h.section('PHASE 12 §11 — ownership, attribution, and one file filed under the wrong heading');

test('PHASE 12: the gate REFUSES a projection-alpha network it did not create', () => {
  const code = codeOf(read(GATE));
  // THE DEFECT. The cleanup removes `projection-alpha` unconditionally, because the shipped profile creates
  // it and a run that left it behind would fail its own residue check. A network that was ALREADY THERE is
  // one somebody else made — an operator, a stopped deployment, another checkout — and removing it is this
  // gate taking ownership of what is not ours, which is the whole of §4's fourth refusal. The appliance's own
  // NAME was refused for exactly this reason and the network beside it was not.
  const refusalAt = code.indexOf('a $ALPHA_NETWORK network already exists on this host');
  assert(refusalAt > 0, 'the gate adopts a projection-alpha network it did not create, and then destroys it');
  assert(/docker network ls --format '\{\{\.Name\}\}' \| grep -qx "\$ALPHA_NETWORK"/.test(code),
    'the network precondition does not match the name exactly, so a substring would satisfy it');
  // BEFORE ANYTHING IS CREATED, like every other precondition.
  const workAt = code.indexOf('GATE_ROOT="${PROJECTION_PHASE11_GATE_ROOT');
  assert(workAt > 0 && refusalAt < workAt, 'the network precondition runs after the run directory exists');
  // AND IT IS A REFUSAL RATHER THAN A SKIP, because a foreign network is a fact about the host's STATE that
  // somebody can change, not about the host's capabilities. The two skip probes are unaffected.
  const region = code.slice(refusalAt - 200, refusalAt + 200);
  assert(/fail "/.test(region) && !/skip "/.test(region),
    'a foreign network SKIPS rather than refusing, which folds somebody else\'s state into "this host cannot"');
});

test('PHASE 12: P11-M2 quiesces the origin before the REMOTE read as well as before the local one', () => {
  const code = codeOf(read(GATE));
  const quiesces = (code.match(/^await_quiet_origin \\?$/gm) ?? []).length;
  assertEq(quiesces, 2,
    'the origin is quiesced before only one of the two reads. §7 R8\'s argument is symmetric: "the counters '
    + 'moved" is satisfied by ANY traffic, including a probe cache the daemon was warming on its own, so an '
    + 'appliance that never served the range read would still have reported that it did');
  const localAt = code.indexOf('COUNTERS_BEFORE_LOCAL=');
  const remoteAt = code.indexOf('COUNTERS_BEFORE_REMOTE=');
  assert(localAt > 0 && remoteAt > localAt, 'the two reads are no longer ordered local-then-remote');
  const between = code.slice(localAt, remoteAt);
  assert(between.includes('await_quiet_origin'), 'nothing quiesces the origin between the two reads');
});

test('PHASE 12: the worker driver OUTPUT is scanned by both halves of the redaction scan', () => {
  const body = read(GATE);
  const secretsAt = body.indexOf('if grep -qiE "$SECRETS_SHAPE"');
  const beforeScans = body.slice(0, secretsAt);
  // A MIS-FILING RATHER THAN A DECISION. The exclusion list is "the inputs this run wrote for the shipped
  // commands to READ"; `worker.json` is an OUTPUT the worker driver produced, and an output is exactly what
  // this scan exists to read.
  assert(!/\|worker\.json\)/.test(beforeScans) && !/worker\.json\|/.test(beforeScans),
    'the worker driver\'s own output is excluded from the redaction scan as though it were an input');
  // AND THE THINGS THAT REALLY ARE INPUTS STAY EXCLUDED, because a scan that failed on the operator's own
  // object manifest would be a scan nobody keeps.
  for (const input of ['content.json', 'config.json', 'torbox-objects.json']) {
    assert(beforeScans.includes(input), `${input} is no longer excluded, and it carries a reference by design`);
  }
});

h.section('PHASE 12 §11 — two empty strings compare equal, and a counter that did not run reports zero');

/**
 * One shell FUNCTION lifted out of the shipped gate and DRIVEN, the way the `.cjs` helpers below are driven.
 *
 * READING A GUARD IS NOT TESTING IT. These two functions are the whole of the repair for a defect whose
 * symptom is a PASS, so a suite that asserted they appear in the file would be a suite that could not tell a
 * working guard from a `return 0`.
 */
function shellFunctionFrom(body: string, name: string): string {
  const from = body.indexOf(`\n${name}() {`);
  assert(from > 0, `the gate no longer defines ${name}()`);
  const to = body.indexOf('\n}\n', from);
  assert(to > from, `${name}() has no closing brace this reader can find`);
  return body.slice(from, to + 3);
}

function runShellSnippet(snippet: string): { status: number; out: string } {
  const shell = shellOrThrow();
  const dir = freshDir();
  const file = join(dir, 'drive.sh');
  writeFileSync(file, `set -uo pipefail\n${snippet}\n`);
  chmodSync(file, 0o755);
  const result = spawnSync(shell, [shPath(file)], { encoding: 'utf8' });
  return { status: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('PHASE 12: same_bytes REFUSES two empty digests, which is the answer "nothing was read" produces', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const fn = shellFunctionFrom(read(GATE), 'same_bytes');
  // THE DEFECT, DRIVEN. `consumer_sha` sends its errors to /dev/null, so a mount that is not there returns
  // the EMPTY STRING — and `[ "" = "" ]` is true. P11-M3 and P11-M4 each compared one of those against
  // another, so an appliance that had died between two arms would have reported the provider-backed half as
  // byte-identical before and after and the arm would have passed on the absence of what it measures.
  const empty = runShellSnippet(`${fn}\nsame_bytes "a read that did not happen" "" ""`);
  assertEq(empty.status !== 0, true,
    'two empty digests compared equal, so an appliance that read nothing would report its bytes unmoved');
  assert(/EMPTY/.test(empty.out), 'the refusal does not say that a digest was empty, so nobody could diagnose it');
  const oneEmpty = runShellSnippet(`${fn}\nsame_bytes "half a read" "abc" ""`);
  assertEq(oneEmpty.status !== 0, true, 'one empty digest was accepted as a comparison');
  // AND IT STILL ANSWERS THE TWO REAL QUESTIONS, because a guard that refused everything would fail the arm
  // it is supposed to let pass.
  assertEq(runShellSnippet(`${fn}\nsame_bytes "equal" "abc" "abc"`).status, 0, 'two equal digests were refused');
  assertEq(runShellSnippet(`${fn}\nsame_bytes "moved" "abc" "abd"`).status !== 0, true,
    'two DIFFERENT digests compared equal, so the guard cannot see a byte that moved');
});

test('PHASE 12: numeric REFUSES a counter that produced no number, which shell arithmetic turns into 0', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const fn = shellFunctionFrom(read(GATE), 'numeric');
  // THE ARITHMETIC THAT MADE THIS SILENT, ASSERTED HERE SO THE REASON IS NOT ONLY IN A COMMENT.
  const arithmetic = runShellSnippet('A=""\nB=""\necho "$((A + B))"');
  assertEq(arithmetic.out.trim(), '0',
    'this shell does not turn an empty operand into zero, so the defect model behind numeric() is wrong');
  assertEq(runShellSnippet(`${fn}\nnumeric "an empty counter" ""`).status !== 0, true,
    'an empty counter passed, so a field diff that failed to run would have contributed the budget itself');
  assertEq(runShellSnippet(`${fn}\nnumeric "a word" "no such file"`).status !== 0, true, 'a non-number passed');
  assertEq(runShellSnippet(`${fn}\nnumeric "a real count" "0"`).status, 0, 'a real zero was refused');
  assertEq(runShellSnippet(`${fn}\nnumeric "a real count" "12"`).status, 0, 'a real count was refused');
});

test('PHASE 12: every byte comparison and every derived number in the gate goes through a guard', () => {
  const code = codeOf(read(GATE));
  // THE CALL SITES, PINNED BY NAME. A guard that exists and is used at three of five call sites is a guard
  // whose two remaining sites are the ones nobody will look at again.
  for (const pair of ['"$LOCAL_THROUGH_MOUNT" "$LOCAL_ON_DISK"', '"$REMOTE_THROUGH_MOUNT" "$REMOTE_AFTER_PUBLISH"',
    '"$LOCAL_DURING_OUTAGE" "$LOCAL_ON_DISK"', '"$REMOTE_AFTER_LOSS" "$REMOTE_THROUGH_MOUNT"',
    '"$POINTER_BEFORE" "$POINTER_AFTER"']) {
    assert(code.includes(pair), `the byte comparison over ${pair} is no longer made where this suite looks`);
    const at = code.indexOf(pair);
    const line = code.lastIndexOf('\n', code.lastIndexOf('\n', at - 1) - 1);
    assert(code.slice(Math.max(0, line), at).includes('same_bytes'),
      `${pair} is compared without the guard, so two empty digests would compare equal`);
  }
  for (const counter of ['"$M4_A"', '"$M4_B"', '"$M3_MOVED"', '"$UNREACHED"', '"$UNDECLARED"']) {
    assert(new RegExp(`numeric [^\\n]*${counter.replace(/\$/g, '\\$')}`).test(code),
      `${counter} is compared against a budget without being asserted to be a number first`);
  }
});

test('CONTROL: a byte comparison written WITHOUT the guard is CAUGHT', () => {
  const body = read(GATE);
  const tampered = body.replace(
    /same_bytes "the provider-backed half before and after the worker output was lost" \\\n  /,
    '[ ');
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  const code = codeOf(tampered);
  const at = code.indexOf('"$REMOTE_AFTER_LOSS" "$REMOTE_THROUGH_MOUNT"');
  assert(at > 0, 'the tampered comparison vanished entirely, so this control is measuring the wrong thing');
  const line = code.lastIndexOf('\n', code.lastIndexOf('\n', at - 1) - 1);
  assert(!code.slice(Math.max(0, line), at).includes('same_bytes'),
    'an unguarded comparison still reads as guarded, so the check above would not have caught the original '
    + 'defect either');
});

h.section('PHASE 12 §11 — the run directory has to be somewhere the appliance can bind it');

/**
 * THE DEFECT, AND IT IS THE ONE THAT DECIDED WHETHER THIS GATE COULD RUN AT ALL ON THE HOST §9.1 NAMES.
 *
 * The gate took its run directory from `mktemp -d`. On the real Unraid host that answers `/tmp/tmp.X`, which
 * resolves to `/` — propagation `private`. The shipped appliance profile binds the mount point `:rshared`,
 * because that is what makes the namespace visible to a media server in another container, and Docker REFUSES
 * an `rshared` bind whose source is not on a shared subtree. `alpha start` would have failed, P11-M2 would
 * have gone red, and the colour would have been about which directory the run happened to be in.
 *
 * The repair has two halves and this suite pins both, because either alone is a half-repair that reads like a
 * whole one: the run directory now sits under the checkout, the way every other mounting gate here roots its
 * own, AND the propagation is PROBED before anything is created, so a host that still cannot host it SKIPS
 * with 77 rather than failing an arm about its own mount table.
 */
const RUN_ROOT_SHAPE = /GATE_ROOT="\$\{PROJECTION_PHASE11_GATE_ROOT:-\$ROOT\/\.projection-phase11-mixed-gate\}"/;

test('PHASE 12: the run directory is rooted under the checkout, not at mktemp -d', () => {
  const code = codeOf(read(GATE));
  assert(RUN_ROOT_SHAPE.test(code),
    'the gate no longer roots its run directory under the checkout, so on a host whose temporary directory is '
    + 'on a private subtree the appliance cannot bind its own mount point');
  assert(!/WORK="\$\(mktemp -d\)"/.test(code),
    'the gate is back on mktemp -d, which on the real Unraid host puts the mount point on a private subtree');
  assert(/WORK="\$GATE_ROOT\/run-\$\$"/.test(code),
    'the run directory is not a per-process child of the gate root, so two runs would share one');
});

test('PHASE 12: mount propagation is PROBED before anything is created, and failing it SKIPS', () => {
  const body = read(GATE);
  const code = codeOf(body);
  const probeAt = code.indexOf('findmnt -no PROPAGATION -T "$WORK"');
  assert(probeAt > 0, 'the gate never asks whether its run directory is on a shared subtree');
  // BEFORE ANYTHING IS CREATED. The baselines are taken immediately before the first container exists, so a
  // probe after them is a probe that already cost the host something.
  const baselineAt = code.indexOf('CONTAINERS_BEFORE=');
  assert(baselineAt > 0 && probeAt < baselineAt,
    'the propagation probe runs after the host baseline is taken, so it is no longer a precondition');
  assert(/\*shared\*\)/.test(code), 'the probe does not accept a shared subtree by its propagation word');
  // AND IT IS A SKIP RATHER THAN A FAILURE. §7 R5: a red run caused by which machine it was launched on is
  // not a verdict about the product.
  const probeRegion = code.slice(probeAt, probeAt + 1200);
  assert(/skip "/.test(probeRegion), 'a run directory on a private subtree FAILS the gate rather than skipping it');
  assert(body.includes('PROJECTION_PHASE11_GATE_ROOT'),
    'the skip names no way for an operator to point the run at a shared subtree, so it is a dead end');
});

test('PHASE 12: the run directory is removed through the shipped cleanup, not through rm -rf', () => {
  const code = codeOf(read(GATE));
  // THE LEAK THIS CLOSES WAS MEASURED ON THE REAL HOST AND NOWHERE ELSE: four runs, four dangling
  // mountpoints. On the failure paths the trap exists for, the appliance's FUSE mount may still be standing
  // at `$WORK/mnt`, and `rm -rf` over a live mount leaves the mountpoint for the next run to inherit.
  assert(/\.\s+"\$HERE\/projection-gate-cleanup\.sh"/.test(code),
    'the gate does not source the shipped cleanup, so it carries its own idea of how a mount comes off');
  assert(/projection_gate_cleanup_run "\$GATE_ROOT" "\$WORK" "\$VERIFY_IMAGE"/.test(code),
    'the trap does not remove the run directory through the shipped cleanup');
  assert(/projection_gate_report_cleanliness/.test(code),
    'nothing reports whether a mountpoint was left behind, and an unreported leak is one nobody repairs');
  const trapAt = code.indexOf('cleanup() {');
  const trapEnd = code.indexOf('trap cleanup EXIT');
  assert(trapAt > 0 && trapEnd > trapAt, 'the cleanup function could not be located');
  assert(!/rm -rf "\$WORK"/.test(code.slice(trapAt, trapEnd)),
    'the trap still removes the run directory with rm -rf, which is what leaves a mountpoint behind');
});

test('CONTROL: a gate that goes back to mktemp -d, or drops the propagation probe, is CAUGHT', () => {
  const body = read(GATE);
  const backToMktemp = body.replace(/GATE_ROOT="[^"]*"\nWORK="\$GATE_ROOT\/run-\$\$"/, 'WORK="$(mktemp -d)"');
  assert(backToMktemp !== body, 'the tamper did not apply, so this control proves nothing');
  assert(!RUN_ROOT_SHAPE.test(codeOf(backToMktemp)) || /WORK="\$\(mktemp -d\)"/.test(codeOf(backToMktemp)),
    'a gate returned to mktemp -d still reads as rooted under the checkout');

  const withoutProbe = body.replace(/case "\$\(findmnt -no PROPAGATION[\s\S]*?\nesac\n/, '');
  assert(withoutProbe !== body, 'the propagation tamper did not apply, so this control proves nothing');
  assert(!withoutProbe.includes('findmnt -no PROPAGATION -T "$WORK"'),
    'the propagation probe survived its own removal, so the check above cannot tell it is gone');
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

test('the arm-list helper really does read the SIX ids out of the contract\'s own module', () => {
  // P11-M6's DENOMINATOR, DRIVEN. Every other part of that arm is arithmetic over this program's output, so
  // a helper that printed nothing would make "zero arms unreached" true of an empty list — the most
  // comfortable wrong answer available to this tranche.
  const helper = join(freshDir(), 'arms.mts');
  const body = read(GATE);
  const start = body.indexOf("<<'ARMS'\n");
  const end = body.indexOf('\nARMS\n', start);
  assert(start > 0 && end > start, 'the gate no longer writes an arm-list helper');
  writeFileSync(helper, `${body.slice(start + "<<'ARMS'\n".length, end)}\n`);

  // THE REPOSITORY ROOT, NOT THIS SUITE'S DIRECTORY. `new URL('.', import.meta.url)` is `test/`, and handing
  // that over made the helper look for `test/src/core/projection/phase11.ts` — which this arm caught on its
  // first execution, which is the whole reason it drives the program instead of reading it.
  const rootUrl = new URL('../', import.meta.url).href;
  // tsx is resolved BY PATH so this suite never depends on `npx` reaching a network.
  const run = spawnSync(process.execPath, [
    join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), helper,
  ], { encoding: 'utf8', env: { ...process.env, PHASE11_ROOT_URL: rootUrl } });
  assertEq(run.status, 0, `the arm-list helper failed: ${run.stdout}${run.stderr}`);
  assertEq(`${run.stdout}`.trim().split(/\r?\n/).join(','), [...PHASE11_ARM_GATE_IDS].join(','),
    'the helper does not print the contract\'s six arm ids in the contract\'s order');
});

test('PHASE 12: the kind counter counts PER ENTRY, over the PUBLISHED set, and not by substring', () => {
  // P11-M1's measurement, DRIVEN. It replaced two substring greps over the whole status document — a check
  // that could not say which entry carried which kind, whether either was published, or whether the word
  // simply appeared in a field this gate does not own the shape of.
  const helper = helperFrom('KINDS', 'kinds.cjs');
  const dir = freshDir();
  const at = (name: string, doc: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(doc));
    return file;
  };

  const mixed = at('mixed.json', { entries: [
    { path: 'a', kinds: ['http-range'], publication: 'published' },
    { path: 'b', kinds: ['local'], publication: 'published' },
  ] });
  assertEq(runNode(helper, [mixed]).out, '1 1', 'a genuinely mixed published generation was not counted as one');

  // AN ADMITTED ENTRY NOBODY PUBLISHED IS NOT PART OF THE PUBLISHED GENERATION, and P11-M1's claim is about
  // one published generation holding both kinds.
  const unpublished = at('unpublished.json', { entries: [
    { path: 'a', kinds: ['http-range'], publication: 'published' },
    { path: 'b', kinds: ['local'], publication: 'admitted-not-published' },
  ] });
  assertEq(runNode(helper, [unpublished]).out, '1 0',
    'an entry that was never published counted towards the published generation, so P11-M1 would pass on a '
    + 'mixture that is not in the generation it is about');

  // AND THE DEFECT ITSELF: a document holding only provider-backed entries, with the word "local" elsewhere
  // in it. Both original greps would have been satisfied by this and the arm would have passed.
  const substringOnly = at('substring.json', { note: 'a local root was resolved', entries: [
    { path: 'a', kinds: ['http-range'], publication: 'published' },
    { path: 'b', kinds: ['http-range'], publication: 'published' },
  ] });
  assertEq(runNode(helper, [substringOnly]).out, '2 0',
    'the word "local" appearing anywhere in the document was counted as a worker-produced entry');
  assertEq(runNode(helper, [at('empty.json', { entries: [] })]).out, '0 0', 'an empty generation was not zero');
});

test('PHASE 12: P11-M1 no longer greps for its two kinds, and its minimums come from the module', () => {
  // THE HEREDOCS ARE BLANKED, not just the comments: `kinds.cjs` NAMES the two greps it replaced in its own
  // explanation, and a model that read them as shell would report the defect as still present in the repair.
  const code = shellCodeOf(read(GATE));
  assert(!/grep -q 'http-range'/.test(code) && !/grep -q '"local"'/.test(code),
    'P11-M1 is back to substring greps over the whole status document, which cannot say which entry carried '
    + 'which kind or whether it was published');
  assert(/node "\$WORK\/kinds\.cjs" "\$WORK\/status-1\.json"/.test(code),
    'P11-M1 does not count the published entries of each kind');
  // THE MINIMUMS COME FROM THE CONTRACT'S OWN MODULE, the way P11-M6's denominator does. A gate carrying its
  // own copy of a threshold is a gate whose threshold can drift from the document's in the passing direction.
  assert(/npx tsx "\$WORK\/minimums\.mts"/.test(code), 'the minimums are not read out of the module');
  assert(/MIN_TORBOX_ENTRIES/.test(read(GATE)) && /MIN_ADMITTED_USENET_ENTRIES/.test(read(GATE)),
    'the minimums helper does not name the two rules §5.3 says P11-M1 is measured against');
  assert(/KIND_CONTROL/.test(code),
    'nothing proves the kind counter can count, so the mixture P11-M1 reports would prove nothing');
  // AND THE MINIMUMS ARE THEMSELVES FLOOR-CHECKED, because a module edited to zero would make a generation
  // holding one kind satisfy both.
  assert(/\[ "\$MIN_REMOTE" -ge 1 \] && \[ "\$MIN_LOCAL" -ge 1 \]/.test(code),
    'a mixed-generation minimum of zero would be accepted, and a generation holding one kind would pass');
});

test('CONTROL: a P11-M1 that goes back to substring greps is CAUGHT', () => {
  const body = read(GATE);
  const tampered = body.replace(/MIXED_COUNTS="\$\(node "\$WORK\/kinds\.cjs"[\s\S]*?so it is not a mixed generation" >&2; M1=fail; \}\n/,
    `grep -q 'http-range' "$WORK/status-1.json" || M1=fail\ngrep -q '"local"' "$WORK/status-1.json" || M1=fail\n`);
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  const code = shellCodeOf(tampered);
  assert(/grep -q 'http-range'/.test(code) && !/node "\$WORK\/kinds\.cjs" "\$WORK\/status-1\.json"/.test(code),
    'a P11-M1 returned to substring greps still reads as counting entries, so the check above would not have '
    + 'caught the original defect either');
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

test('the three shipped scripts carry no carriage return, which is what `shellFunctionFrom` rests on', () => {
  // `shellFunctionFrom` above locates a function with `indexOf('\n}\n')` — a literal carrying a bare LF, which
  // matches nothing in a CRLF file. It is safe here ONLY because `.gitattributes` pins `*.sh` to LF on every
  // platform, and it fails loudly rather than silently if that ever stops being true. This says so by name.
  //
  // WHY IT IS WORTH A TEST OF ITS OWN. The `*.ts` files are deliberately NOT pinned, and at the Phase 10-12
  // integration merge three pins that sliced a `.ts` source the same way went red on an ordinary Windows
  // checkout against bytes identical to the branch they merged — one of them reporting that a shipped verb
  // writes outside a transaction. `test/helpers/ts-source.ts` is the repair for the unpinned side; this is
  // the assertion that the pinned side is still pinned.
  for (const path of [GATE, THREE, OPTIONAL]) {
    const raw = readFileSync(join(repoRoot, path));
    assertEq(raw.includes(0x0d), false, `${path} holds a CR; .gitattributes pins shipped shell to LF`);
  }
  assert(read('.gitattributes').includes('*.sh text eol=lf'), '.gitattributes no longer pins shell scripts to LF');
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
