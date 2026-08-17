import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { NO_SHELL, posixShell, shPath, shellOrThrow } from './posix-shell-kit.js';
import {
  PHASE10_CLOSURE_GATE_IDS,
  PHASE10_REHEARSAL_EMITTABLE_GATE_IDS,
  PHASE10_SEQUENCE_LEVEL_GATE_IDS,
} from '../src/core/projection/phase10.js';

// Projection Phase 10 — the rehearsal gate audit.
//
// WHAT THIS SUITE EXISTS FOR, AND THE HISTORY BEHIND IT. Phase 8's gate defined a function and never called
// it, so the file every later assertion read was never written, and every cycle failed against a product that
// had done nothing wrong. `bash -n` did not catch it. An id audit did not catch it. Only RUNNING it did, six
// hours in. Phase 10's rehearsal is provider-free and minutes long rather than hours, which lowers the cost
// of that failure and does not change its shape.
//
// SO THE CLASSES OF DEFECT THIS FILE IS AIMED AT ARE THE ONES THAT SURVIVE A SYNTAX CHECK:
//
//   A FUNCTION THAT IS DEFINED AND NEVER CALLED. Pinned by name, both ways.
//   A VARIABLE READ UNDER `set -u` THAT NOTHING EVER SETS.
//   A VERDICT ID THE CLOSURE RULE DOES NOT NAME, or a §5 id the rehearsal claims and may not.
//   A WRAPPER THAT RUNS SOMETHING OTHER THAN THE THING IT NAMES. Pinned by DRIVING it against a stub.
//   AN ACCOUNTING LOOP THAT CAN ANNOUNCE A SEQUENCE IT DID NOT COMPLETE. Pinned by driving it.
//
// AND EVERY ONE OF THEM HAS A CONTROL THAT PROVES THE AUDIT BITES. Phase 8's lesson was not "write an audit";
// it was that the old pin — strip the suffix, grep for the bare string — was green against a gate recording
// five ids with no suffix at all. An audit nobody has watched fail is an audit nobody should believe, so each
// structural check below is re-run against a DELIBERATELY BROKEN COPY of the script and asserted to fail.
//
// THE SHELL IS CHOSEN BY EXECUTION, NOT BY NAME. `./posix-shell-kit.js` makes each candidate EXECUTE a script
// at the path spelling this suite hands out and keeps the first that can. Started from an ordinary PowerShell,
// bare `bash` on a stock Windows PATH is the WSL launcher, which cannot address a Windows drive path in any
// spelling and answers 127 — the same number these controls assert on. A green figure from one terminal and
// red from another, about the same commit, is not a verdict about the product at all.

const h = createHarness('Projection Phase 10 — the rehearsal gate audit');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const REHEARSAL = 'deploy/projection-phase10-rehearsal.sh';
const THREE = 'deploy/projection-phase10-rehearsal-three.sh';
const OPTIONAL = 'deploy/projection-phase10-rehearsal-optional.sh';
const CONTENT = 'deploy/projection-content.sh';

const tmpDirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'phase10-audit-'));
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
 * and `"§4's second hard refusal"` are apostrophes inside DOUBLE quotes, which are not shell quoting at all,
 * and each one shifts the pairing by one — so a run of prose silently blanks the assignments after it and
 * unblanks the JavaScript before it. It reported `$MEDIA_ROOT` as unbound in a script that assigns it on its
 * own line, which is exactly the false failure that gets an audit deleted rather than fixed.
 *
 * So the two constructs that really are literal here are named: a `node -e '…'` argument, and a heredoc whose
 * tag is quoted (`<<'TAG'`). Both are places this project deliberately puts a different language, and the
 * variables inside them belong to that language.
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
 * audit deleted. So a name at the start of a command, after `||`, `&&`, `;`, `(`, `{` or a pipe counts.
 */
function calledFunctions(body: string, names: readonly string[]): ReadonlySet<string> {
  const code = codeOf(body);
  const called = new Set<string>();
  for (const name of names) {
    const pattern = new RegExp(`(^|[;&|(){}\\n]|\\|\\||&&)\\s*${name}\\b(?!\\s*\\(\\)\\s*\\{)`, 'm');
    // `trap NAME EXIT` IS A CALL, and it is the one that matters most: `cleanup` is the function a gate's
    // whole "leaves nothing behind" claim rests on, and it is never invoked by name anywhere else. A model
    // that missed it would report the single most load-bearing helper in the file as dead code.
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
  return [...codeOf(body).matchAll(/^\s*verdict\s+(P10-[A-Za-z0-9-]+)\s+(\S+)/gm)]
    .map((match) => ({ id: match[1] as string, outcome: match[2] as string }));
}

/**
 * The distinct verdict ids the rehearsal records.
 *
 * TWO CALL SITES FOR ONE ID ARE NOT AUTOMATICALLY A DUPLICATE, and getting that wrong in either direction is
 * how an id audit becomes useless. A step written as an `if` records `verdict X pass` in one arm and
 * `verdict X fail` in the other, and exactly one of them runs. A step written as `verdict X "$RESULT"` records
 * one, whatever the outcome. `duplicateVerdictIds` below is what distinguishes those legitimate shapes from
 * the defect: the SAME outcome recorded twice, or a literal outcome and a variable one mixed for one id, both
 * of which mean two things can answer to one claim in one run.
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

  if (relative === REHEARSAL) {
    const recorded = recordedVerdictIds(body);
    if (recorded.length === 0) problems.push(`${relative} records no verdict at all`);
    for (const id of recorded) {
      if (!(PHASE10_CLOSURE_GATE_IDS as readonly string[]).includes(id)) {
        problems.push(`${relative} records ${id}, which §5 does not name`);
      }
      if ((PHASE10_SEQUENCE_LEVEL_GATE_IDS as readonly string[]).includes(id)) {
        problems.push(`${relative} records ${id}, which is a claim about a set of runs one run may not answer`);
      }
    }
    // EXPANDED AGAINST THE CONTRACT AS A MULTISET, not as a subset. A rehearsal that answered five of the six
    // it may answer is a rehearsal whose green run is missing a claim nobody counted.
    for (const id of PHASE10_REHEARSAL_EMITTABLE_GATE_IDS) {
      if (!recorded.includes(id)) problems.push(`${relative} never records ${id}, which it is the instrument for`);
    }
    for (const id of duplicateVerdictIds(body)) {
      problems.push(`${relative} records ${id} twice, so it is not clear which is the run's`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------------------

h.section('the scripts parse, and the shell that parses them is chosen by execution');

test('all four shipped scripts pass a syntax check', () => {
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  for (const relative of [REHEARSAL, THREE, OPTIONAL, CONTENT]) {
    const result = spawnSync(shell, ['-n', shPath(join(repoRoot, relative))], { encoding: 'utf8' });
    assertEq(result.status, 0, `${relative} does not parse: ${result.stderr}`);
  }
});

h.section('the structural audit, over the shipped bytes');

test('nothing is defined and never called, and nothing is read that nothing sets', () => {
  for (const relative of [REHEARSAL, THREE, OPTIONAL, CONTENT]) {
    const problems = auditProblems(relative, read(relative));
    assertEq(problems.join(' | '), '', `${relative} did not survive the audit`);
  }
});

test('the rehearsal records exactly the six claims it may answer, and none of the four it may not', () => {
  const recorded = recordedVerdictIds(read(REHEARSAL));
  assertEq([...recorded].sort().join(','), [...PHASE10_REHEARSAL_EMITTABLE_GATE_IDS].sort().join(','),
    'the rehearsal\'s verdict multiset is not the contract\'s rehearsal-emittable set');
});

test('every verdict the rehearsal records is stamped rehearsal=true', () => {
  const code = codeOf(read(REHEARSAL));
  assert(/rehearsal=true/.test(code),
    'the rehearsal emits verdicts that do not say they came from a rehearsal, and phase10.ts reads that field '
    + 'to refuse a closure');
  assert(!/rehearsal=false/.test(code), 'the rehearsal can emit a non-rehearsal verdict');
});

test('the rehearsal names the four claims it cannot answer, in its own closing message', () => {
  const body = read(REHEARSAL);
  for (const id of PHASE10_SEQUENCE_LEVEL_GATE_IDS) {
    assert(body.includes(id),
      `the rehearsal does not name ${id} as still open, and a run whose output does not list what it did not `
      + 'prove is a run that has quietly started reading as a closure');
  }
});

test('the rehearsal contacts no provider and asserts endpoint.json is unmoved', () => {
  // THE FORBIDDEN LIST IS ABOUT CONTACTING A PROVIDER, NOT ABOUT THE WORD. This rehearsal legitimately runs
  // `add-torbox` and writes `add-torbox.txt`, because registering an opaque reference is what provider-free
  // TorBox registration IS. What it may not do is name an endpoint, a worker or an origin allowlist.
  const code = codeOf(read(REHEARSAL));
  for (const forbidden of ['torbox.app', 'api.torbox', 'sabnzbd', 'nntp:', 'nntps:', 'allowedorigins',
    'real-provider-objects.json']) {
    assert(!code.toLowerCase().includes(forbidden),
      `the rehearsal names ${forbidden}, which is a provider it may not contact`);
  }
  assert(/ENDPOINT_MTIME_BEFORE/.test(code) && /ENDPOINT_MTIME_AFTER/.test(code),
    'the rehearsal does not record endpoint.json\'s mtime before and after, so §4\'s third refusal is a '
    + 'promise rather than an assertion');
});

test('the rehearsal SKIPS rather than fails when the host cannot express the paths the command requires', () => {
  const body = read(REHEARSAL);
  const probeProgram = body.slice(body.indexOf("<<'PROBE'"), body.indexOf('\nPROBE\n'));
  assert(probeProgram.length > 0, 'the rehearsal has no run-directory path probe');
  // THE PROBE MUST NOT USE ARGV. Under MSYS a POSIX-looking argument is rewritten on the way to a native
  // binary, so an argv probe passes on exactly the host it exists to catch.
  assert(/readFileSync/.test(probeProgram),
    'the path probe reads the path from argv, which MSYS rewrites — so it would pass on the host it exists '
    + 'to catch');

  const invocation = codeOf(body).slice(codeOf(body).indexOf('.path-probe'), codeOf(body).indexOf('CONTAINERS_BEFORE'));
  assert(/skip\s/.test(invocation),
    'the path probe fails the run rather than skipping it, and a red run caused by which machine it was '
    + 'launched on is not a verdict about the product');
});

test('no shipped Phase 10 script passes a MULTI-LINE program to node -e', () => {
  // FOUND BY `test/custody-runtime-closure.ts`, WHICH READS EVERY SHIPPED SCRIPT LINE BY LINE. A multi-line
  // `node -e '` opens a single quote the next line does not close, and a quote a line-based reader cannot
  // close is a quote a human reader cannot close either — it is where an unterminated string silently
  // swallows the next command. The JavaScript lives in heredoc-written files instead.
  for (const relative of [REHEARSAL, THREE, OPTIONAL, CONTENT]) {
    const code = codeOf(read(relative));
    assert(!/node\s+-e\s+'[^']*\n/.test(code),
      `${relative} passes a multi-line program to node -e, which leaves every line after it unreadable`);
  }
});

test('a FAILED rehearsal does not print the paragraph describing what it proved', () => {
  const code = codeOf(read(REHEARSAL));
  const guard = code.indexOf('if [ "$FAIL" -ne 0 ]; then');
  const paragraph = code.indexOf('WHAT THIS PROVED.');
  assert(guard > 0, 'nothing guards the closing paragraph on the failure count');
  assert(guard < paragraph,
    'the rehearsal narrates what it proved before it checks whether it passed — the first real execution of '
    + 'this script printed the whole paragraph under "4 passed, 2 failed"');
});

test('the rehearsal compares the host\'s container, network and volume SETS rather than counts', () => {
  const code = codeOf(read(REHEARSAL));
  for (const name of ['CONTAINERS_BEFORE', 'NETWORKS_BEFORE', 'VOLUMES_BEFORE']) {
    assert(code.includes(name), `the rehearsal takes no ${name} baseline`);
  }
  // Phase 8 §11's precedent: two containers appearing while two others left is a count that agrees and a host
  // that changed.
  assert(!/docker ps -aq \| wc -l/.test(code), 'the rehearsal compares counts rather than sets');
});

h.section('THE CONTROLS — each one proves the audit bites');

test('CONTROL: a function defined and never called is CAUGHT', () => {
  const tampered = `${read(REHEARSAL)}\nunreachable_helper() {\n  echo "nothing calls me"\n}\n`;
  const problems = auditProblems(REHEARSAL, tampered);
  assert(problems.some((problem) => /unreachable_helper\(\) and never calls it/.test(problem)),
    'the audit did not notice a function that is defined and never called — which is defect #11 of Phase 8, '
    + 'the one that cost six hours');
});

test('CONTROL: a variable read under set -u that nothing sets is CAUGHT', () => {
  const tampered = read(REHEARSAL).replace('say "migrated"', 'say "migrated $NEVER_ASSIGNED_ANYWHERE"');
  assert(tampered !== read(REHEARSAL), 'the tamper did not apply, so this control proves nothing');
  const problems = auditProblems(REHEARSAL, tampered);
  assert(problems.some((problem) => /\$NEVER_ASSIGNED_ANYWHERE/.test(problem)),
    'the audit did not notice an unbound variable, which under set -u is a dead run');
});

test('CONTROL: a verdict id the contract does not name is CAUGHT', () => {
  const tampered = read(REHEARSAL).replace(
    'verdict P10-8-cleanup-leaves-nothing "$P10_8"', 'verdict P10-99-invented-claim "$P10_8"');
  assert(tampered !== read(REHEARSAL), 'the tamper did not apply');
  const problems = auditProblems(REHEARSAL, tampered);
  assert(problems.some((problem) => /P10-99-invented-claim, which §5 does not name/.test(problem)),
    'the audit accepted an id the closure rule does not name');
});

test('CONTROL: a rehearsal claiming a SEQUENCE-LEVEL id is CAUGHT', () => {
  const tampered = `${read(REHEARSAL)}\nverdict P10-10-three-consecutive-fresh-sequences pass\n`;
  const problems = auditProblems(REHEARSAL, tampered);
  assert(problems.some((problem) => /a claim about a set of runs one run may not answer/.test(problem)),
    'one rehearsal run claimed three consecutive fresh sequences and the audit let it — which is the single '
    + 'property that keeps a green rehearsal from reading as a closure');
});

test('CONTROL: a verdict the rehearsal silently STOPS recording is CAUGHT', () => {
  // The Phase 8 defect in its purest form: fifteen required ids never recorded, and every suite green.
  const tampered = read(REHEARSAL).replace(
    'verdict P10-9-evidence-carries-no-identity "$P10_9"', ': # deliberately no longer recorded');
  assert(tampered !== read(REHEARSAL), 'the tamper did not apply');
  const problems = auditProblems(REHEARSAL, tampered);
  assert(problems.some((problem) => /never records P10-9-evidence-carries-no-identity/.test(problem)),
    'the rehearsal stopped recording a claim it is the instrument for and the audit did not notice');
});

test('CONTROL: one id recorded twice is CAUGHT', () => {
  const tampered = `${read(REHEARSAL)}\nverdict P10-4-operator-path-shipped-verbs-only pass\n`;
  const problems = auditProblems(REHEARSAL, tampered);
  assert(problems.some((problem) => /twice, so it is not clear which is the run's/.test(problem)),
    'a duplicated verdict read as a confirmation');
});

test('CONTROL: the audit is not vacuous — the shipped rehearsal really does define and call functions', () => {
  const defined = definedFunctions(read(REHEARSAL));
  assert(defined.length >= 4, `the rehearsal defines only ${defined.length} functions, so the call-graph model `
    + 'is checking almost nothing and would pass over a script that had lost its helpers');
  assert(defined.includes('verdict') && defined.includes('skip') && defined.includes('fail'),
    'the rehearsal has lost one of the three helpers this audit is built around');
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
    env: { ...process.env, PROJECTION_PHASE10_REHEARSAL_ENTRYPOINT: shPath(stub), ...env },
  });
  return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

test('the optional wrapper folds a SKIP to zero, and says nothing was proved', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const run = runWrapper(OPTIONAL, stubExiting(77));
  assertEq(run.status, 0, 'a skip was not folded');
  assert(/NOTHING WAS PROVED/.test(run.out), 'the fold did not say that nothing was proved');
  assert(/exactly as open/.test(run.out), 'the fold did not say the phase is exactly as open as it was');
});

test('the optional wrapper does NOT fold a FAILURE, which is the whole difference', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  assertEq(runWrapper(OPTIONAL, stubExiting(1)).status, 1, 'a rehearsal that RAN AND FAILED was folded to zero');
  assertEq(runWrapper(OPTIONAL, stubExiting(0)).status, 0, 'a passing rehearsal was not passed through');
});

test('the three-run wrapper runs the entry point it names, three times', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const run = runWrapper(THREE, stubExiting(0));
  assertEq(run.status, 0, 'three passing runs did not succeed');
  assertEq((run.out.match(/stub ran/g) ?? []).length, 3, 'the wrapper did not run its entry point three times');
  assert(/3 of 3 consecutive/.test(run.out), 'the wrapper did not announce a completed sequence');
});

test('the three-run wrapper STOPS on the first failure, and does not announce a sequence', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const run = runWrapper(THREE, stubExiting(1));
  assertEq(run.status, 1, 'a failing run did not fail the sequence');
  assertEq((run.out.match(/stub ran/g) ?? []).length, 1, 'the wrapper kept going after a failure');
  assert(!/consecutive Phase 10 rehearsals completed/.test(run.out), 'a failed sequence announced completion');
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
  const run = runWrapper(THREE, stubExiting(0), { PROJECTION_PHASE10_REHEARSAL_RUNS: '0' });
  assert(run.status !== 0, 'a zero-run sequence exited zero');
  assert(!/consecutive Phase 10 rehearsals completed/.test(run.out), 'a zero-run sequence announced completion');
});

h.section('the shipped content command, driven');

test('the content command refuses a verb it does not have, and needs a configuration', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const shell = shellOrThrow();
  const script = shPath(join(repoRoot, CONTENT));
  const unknown = spawnSync(shell, [script, 'destroy'], { encoding: 'utf8' });
  assertEq(unknown.status, 2, 'an unknown verb was not refused');

  const noConfig = spawnSync(shell, [script, 'status'], {
    encoding: 'utf8', env: { ...process.env, PROJECTION_CONTENT_CONFIG: '' },
  });
  assertEq(noConfig.status, 2, 'the command ran with no configuration, so it could act on a namespace nobody named');
});

test('the content command exits 2 with usage when it is given nothing at all', () => {
  if (posixShell() === null) { assert(true, NO_SHELL); return; }
  const run = spawnSync(shellOrThrow(), [shPath(join(repoRoot, CONTENT))], { encoding: 'utf8' });
  assertEq(run.status, 2, 'a bare invocation did not print usage and exit 2');
  assert(/NOTHING PUBLISHES IMPLICITLY/.test(`${run.stdout}${run.stderr}`),
    'the usage text does not say publishing is explicit, which is the one thing that is easy to get wrong');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase10-gate-audit.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase10-gate-audit.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
