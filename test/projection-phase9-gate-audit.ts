import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { NO_SHELL, posixShell, shPath, shellOrThrow } from './posix-shell-kit.js';

// Projection Phase 9 — the gate audit.
//
// WHAT THIS SUITE EXISTS FOR, AND THE HISTORY BEHIND IT. Phase 8's gate defined a function and never called
// it, so the file every later assertion read was never written, and every cycle failed against a product that
// had done nothing wrong. `bash -n` did not catch it. An id audit did not catch it. Only RUNNING it did, six
// hours in.
//
// So the classes of defect this file is aimed at are the ones that survive a syntax check:
//
//   A FUNCTION THAT IS DEFINED AND NEVER CALLED. Pinned by name, both ways.
//   A VARIABLE READ UNDER `set -u` THAT NOTHING EVER SETS. Pinned by extracting every `$VAR` the script reads
//     and checking each one is either assigned in the script, exported by a wrapper, or has a default.
//   A WRAPPER THAT RUNS SOMETHING OTHER THAN THE GATE IT NAMES. Pinned by DRIVING the wrappers against a stub.
//   AN ACCOUNTING LOOP THAT CAN ANNOUNCE A SEQUENCE IT DID NOT COMPLETE. Pinned by driving it.
//
// The last two are the important ones, and they are BEHAVIOUR rather than source reading: the wrappers are
// pointed at a stub that exits with a scripted status, and the suite asserts what the wrapper does with it.

const h = createHarness('Projection Phase 9 — the rehearsal gate audit');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const REHEARSAL = 'deploy/projection-phase9-rehearsal.sh';
const OPTIONAL = 'deploy/projection-phase9-rehearsal-optional.sh';
const THREE = 'deploy/projection-phase9-rehearsal-three.sh';

// THE SHELL THESE CONTROLS ARE DRIVEN WITH IS CHOSEN BY EXECUTION, NOT BY NAME.
//
// THE DEFECT THAT MADE NINE OF THE EIGHTEEN CONTROLS BELOW RED FOR A REASON THAT HAD NOTHING TO DO WITH THEM.
// This file used to invoke bare `bash` — whatever PATH resolved first. Started from Git Bash that is MSYS
// bash and everything passed. Started from an ordinary PowerShell it is `C:\WINDOWS\system32\bash.exe`, the
// WSL launcher, which cannot address a Windows drive path in any spelling: `bash -n C:\…\rehearsal.sh` failed
// outright, and every wrapper execution came back 127 — the status a shell returns for "command not found".
//
// WHY THAT WAS WORSE THAN AN ORDINARY TEST FAILURE. 127 is a NUMBER, and these controls assert on numbers.
// "a skip was not folded: got 127, want 0" is what this suite prints when the optional wrapper mishandles a
// skip — the single most important property it guards — and it is exactly what it printed when the wrapper
// was fine and the harness could not start it. A green figure from one terminal and nine failures from
// another, about the same commit, is not a verdict about the product at all.
//
// So the shell is selected by `./posix-shell-kit.js`, which makes each candidate EXECUTE a script at the path
// spelling this suite hands out and keeps the first that can. Git Bash is preferred on Windows and bare
// `bash` is tried last there, because bare `bash` is the one most likely to be WSL — and a WSL bash would be
// a different machine with a different toolchain from the checkout these wrappers run `npx` and `docker` out
// of, so it is the wrong answer even when it works.
//
// NOTHING IS WEAKENED BY THIS. Every control still runs, still drives a real wrapper, and still asserts the
// same status and the same text. What changed is which executable receives the call.

/** Blocks that could not be executed here, named and counted so a green summary cannot hide one. */
const skippedBlocks: string[] = [];
function skipBlock(what: string): void {
  skippedBlocks.push(what);
  console.log(`    .. SKIPPED on ${process.platform}: ${NO_SHELL} — ${what}`);
}

const HAS_SHELL = posixShell() !== null;

interface RunResult { readonly status: number; readonly output: string }

function runBash(script: string, env: Record<string, string>): RunResult {
  // stderr is FOLDED INTO stdout deliberately. Every one of these wrappers writes its refusals and its
  // "NOTHING WAS PROVED" to stderr, which is correct — and a harness that only captured stdout would report
  // a silent fold as a silent fold, which is the assertion, so it has to read both.
  //
  // THE SCRIPT IS PASSED AS AN ARGUMENT RATHER THAN INTERPOLATED INTO `-c`. A path inside a `-c` string is a
  // path the shell has to re-parse, and the quoting that survives one shell does not survive the next.
  const result = spawnSync(shellOrThrow(), [shPath(join(repoRoot, script))], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  // A SPAWN THAT NEVER STARTED IS NOT A STATUS THE WRAPPER CHOSE. `status` is null when the child was killed
  // or could not be spawned at all; reporting that as some number would put a harness failure into the same
  // vocabulary the assertions use, which is the whole defect this file just came out of.
  if (result.error !== undefined || result.status === null) {
    throw new Error(`the wrapper could not be executed by the selected shell: ${result.error?.message ?? 'no exit status'}`);
  }
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** A stub that exits with a scripted status, so the wrappers' ACCOUNTING is driven rather than read. */
function withStub(status: number, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'phase9-stub-'));
  const path = join(dir, 'stub.sh');
  try {
    // LF ONLY, EXPLICITLY. A stub written with CRLF is one whose `exit 77\r` the shell reads as a command,
    // and the wrapper under test would then report a status this suite never scripted.
    writeFileSync(path, `#!/usr/bin/env bash\necho "stub ran"\nexit ${status}\n`, 'utf8');
    chmodSync(path, 0o755);
    // The wrapper invokes this path itself, so it is handed over in the spelling a shell reads.
    fn(shPath(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

h.section('syntax, which is necessary and nowhere near sufficient');

test('every rehearsal script parses', () => {
  if (!HAS_SHELL) { skipBlock('the three rehearsal scripts were not parsed'); return; }
  for (const script of [REHEARSAL, OPTIONAL, THREE]) {
    // `-n` is READ AND ASSERTED rather than allowed to throw. A thrown `execFileSync` reports "Command
    // failed: bash -n C:\…" — which is what a shell that cannot address the path says, and also what a
    // genuine syntax error says. The status and stderr tell those two apart.
    const result = spawnSync(shellOrThrow(), ['-n', shPath(join(repoRoot, script))], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert(result.error === undefined, `${script} could not be handed to the shell: ${result.error?.message ?? ''}`);
    assertEq(result.status, 0, `${script} is not valid shell: ${(result.stderr ?? '').trim()}`);
  }
});

h.section('the defect class that survives bash -n: a function defined and never called');

test('every function the rehearsal defines is also called', () => {
  const source = read(REHEARSAL);
  const defined = [...source.matchAll(/^([a-z_][a-z0-9_]*)\(\)\s*\{/gm)].map((match) => match[1] as string);
  assert(defined.length >= 3, 'the rehearsal defines almost no functions, which is suspicious in itself');
  for (const name of defined) {
    // A call is the name at the start of a command, not the definition line.
    const called = new RegExp(`(^|[;&|]|\\bthen\\b|\\belse\\b|\\bdo\\b|\\btrap '|\\btrap )\\s*${name}\\b(?!\\(\\))`, 'm');
    assert(called.test(source), `${name} is defined and never called; this is exactly the Phase 8 defect`);
  }
});

test('every variable the rehearsal reads is one it sets, defaults, or a caller exports', () => {
  const source = read(REHEARSAL);
  const assigned = new Set([...source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1] as string));
  const local = new Set([...source.matchAll(/\blocal\s+([A-Za-z_][A-Za-z0-9_]*)=/g)].map((match) => match[1] as string));
  const loopVars = new Set([...source.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)].map((match) => match[1] as string));
  const builtins = new Set(['PATH', 'HOME', 'PWD', 'IFS', 'BASH_SOURCE', 'FUNCNAME', 'PIPESTATUS', 'RANDOM', 'TZ']);

  for (const match of source.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    const name = match[1] as string;
    if (assigned.has(name) || local.has(name) || loopVars.has(name) || builtins.has(name)) continue;
    // `${VAR:-default}` and `${VAR:?message}` supply their own answer under `set -u`.
    const guarded = new RegExp(`\\$\\{${name}(:-|:\\?)`).test(source);
    assert(guarded, `$${name} is read under set -u and nothing sets it, defaults it or refuses without it`);
  }
});

test('the rehearsal registers cleanup BEFORE it creates anything', () => {
  const source = read(REHEARSAL);
  const trapAt = source.indexOf('trap cleanup EXIT');
  const composeUpAt = source.indexOf('docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up');
  assert(trapAt > 0, 'the rehearsal registers no cleanup');
  assert(composeUpAt > trapAt,
    'the rehearsal creates a container before registering its cleanup, so a failure in between leaves it '
    + 'behind — and §5.10 is a claim about exactly that');
});

test('the rehearsal never contacts a provider, an indexer or the operator\'s own host', () => {
  const source = read(REHEARSAL);
  assert(!/curl |wget |api\.torbox\.app|ssh |tower/i.test(source.replace(/^#.*$/gm, '')),
    'the provider-free rehearsal makes an outbound contact');
});

test('the rehearsal names its own compose project and its own port, and removes volumes on the way out', () => {
  const source = read(REHEARSAL);
  assert(source.includes('PROJECT="projection-phase9-gate"'), 'the compose project is not its own');
  assert(source.includes('5660'), 'the rehearsal does not name its own port');
  assert(source.includes('down -v --remove-orphans'),
    'cleanup leaves volumes behind, so the next run could be lent state by this one');
});

h.section('the wrappers, DRIVEN rather than read');

test('the optional wrapper folds a 77 to 0 and says NOTHING WAS PROVED while doing it', () => {
  if (!HAS_SHELL) { skipBlock('the optional wrapper folds a 77 to 0 and says NOTHING WAS PROVED while doing it'); return; }
  withStub(77, (stub) => {
    const result = runBash(OPTIONAL, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub });
    assertEq(result.status, 0, 'a skip was not folded');
    assert(result.output.includes('NOTHING WAS PROVED'), 'the fold was silent');
    assert(result.output.includes('as open as'), 'the fold did not say the phase is still open');
  });
});

test('the optional wrapper passes a REAL FAILURE through unchanged', () => {
  if (!HAS_SHELL) { skipBlock('the optional wrapper passes a REAL FAILURE through unchanged'); return; }
  withStub(1, (stub) => {
    assertEq(runBash(OPTIONAL, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub }).status, 1,
      'a rehearsal that RAN AND FAILED was folded into success');
  });
  withStub(3, (stub) => {
    assertEq(runBash(OPTIONAL, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub }).status, 3, 'an unusual status');
  });
});

test('the optional wrapper passes a PASS through as a pass', () => {
  if (!HAS_SHELL) { skipBlock('the optional wrapper passes a PASS through as a pass'); return; }
  withStub(0, (stub) => {
    const result = runBash(OPTIONAL, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub });
    assertEq(result.status, 0, 'a pass');
    assert(!result.output.includes('NOTHING WAS PROVED'), 'a pass was reported as a skip');
  });
});

test('the three-runner runs exactly three times and counts them', () => {
  if (!HAS_SHELL) { skipBlock('the three-runner runs exactly three times and counts them'); return; }
  withStub(0, (stub) => {
    const result = runBash(THREE, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub });
    assertEq(result.status, 0, 'three passing runs did not pass');
    assertEq((result.output.match(/stub ran/g) ?? []).length, 3, 'the runner did not run three times');
    assert(result.output.includes('3 of 3 consecutive'), 'the runner did not count');
    assert(result.output.includes('CLOSES NO PART OF PHASE 9'), 'three rehearsals were reported as a closure');
  });
});

test('the three-runner STOPS at the first failure and reports how far it got', () => {
  if (!HAS_SHELL) { skipBlock('the three-runner STOPS at the first failure and reports how far it got'); return; }
  withStub(1, (stub) => {
    const result = runBash(THREE, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub });
    assertEq(result.status, 1, 'a failing run did not fail the sequence');
    assertEq((result.output.match(/stub ran/g) ?? []).length, 1, 'the runner continued past a failure');
    assert(result.output.includes('Runs completed: 0 of 3'), 'the runner did not say how far it got');
  });
});

test('the three-runner PROPAGATES a skip as a skip rather than folding it', () => {
  if (!HAS_SHELL) { skipBlock('the three-runner PROPAGATES a skip as a skip rather than folding it'); return; }
  withStub(77, (stub) => {
    const result = runBash(THREE, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub });
    assertEq(result.status, 77, 'a skipped run was folded inside the three-runner');
    assert(result.output.includes('THIS SEQUENCE PROVES NOTHING'), 'the skip was quiet');
  });
});

test('A ZERO-RUN LOOP CANNOT ANNOUNCE A COMPLETED SEQUENCE', () => {
  if (!HAS_SHELL) { skipBlock('A ZERO-RUN LOOP CANNOT ANNOUNCE A COMPLETED SEQUENCE'); return; }
  withStub(0, (stub) => {
    const result = runBash(THREE, {
      PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub,
      PROJECTION_PHASE9_REHEARSAL_RUNS: '0',
    });
    assert(result.status !== 0, 'a loop that never ran announced a completed sequence');
    assert(result.output.includes('refusing to report a completed sequence'), 'the refusal was silent');
    assertEq((result.output.match(/stub ran/g) ?? []).length, 0, 'a zero-run loop ran something');
  });
});

test('a SHORTENED run count cannot be read as the full sequence', () => {
  if (!HAS_SHELL) { skipBlock('a SHORTENED run count cannot be read as the full sequence'); return; }
  withStub(0, (stub) => {
    const result = runBash(THREE, {
      PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub,
      PROJECTION_PHASE9_REHEARSAL_RUNS: '2',
    });
    assertEq(result.status, 0, 'two of two runs is a complete sequence OF TWO');
    assert(result.output.includes('2 of 2 consecutive'), 'the runner did not say how many it ran');
    assert(!result.output.includes('3 of 3'), 'a two-run sequence announced itself as three');
  });
});

h.section('the rehearsal driver, pinned by name');

test('the rehearsal script runs the driver it claims to, and the driver exists', () => {
  const source = read(REHEARSAL);
  assert(source.includes('src/ops/usenet-rehearsal-cli.ts'), 'the rehearsal does not run the Phase 9 driver');
  assert(read('src/ops/usenet-rehearsal-cli.ts').length > 0, 'the driver does not exist');
});

test('the rehearsal runs the focused offline suites its own §5.1 and §5.8 claims rest on', () => {
  const source = read(REHEARSAL);
  assert(source.includes('--group offline --filter usenet'), 'the rehearsal does not run the Phase 9 suites');
  assert(source.includes('--group offline --filter projection'), 'the rehearsal does not run the projection suites');
});

test('the seam the wrappers are driven through defaults to the real rehearsal', () => {
  for (const script of [OPTIONAL, THREE]) {
    const source = read(script);
    assert(/PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT:-\$HERE\/projection-phase9-rehearsal\.sh/.test(source),
      `${script}'s test seam does not default to the real rehearsal, so an unset variable would run nothing`);
  }
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase9-gate-audit.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase9-gate-audit.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

test('the shell used to drive the wrappers is one that can actually run a script', () => {
  // THE REGRESSION FOR THE HARNESS ITSELF. Nine of the controls above are only worth their `ok` if a real
  // shell executed a real wrapper; before this, bare `bash` on a Windows PATH resolved to the WSL launcher
  // and they failed with 127 in the same vocabulary a genuine wrapper defect fails with. This asserts the
  // selection did its job, and — the important half — that a run which could NOT find a shell says so by
  // name instead of leaving eight green lines that never executed anything.
  const shell = posixShell();
  if (shell === null) {
    assert(skippedBlocks.length > 0, 'no shell was selected and yet nothing reported itself skipped');
    console.log(`    .. ${skippedBlocks.length} block(s) skipped: ${NO_SHELL}`);
    return;
  }
  assertEq(skippedBlocks.length, 0,
    `a shell was selected and ${skippedBlocks.length} block(s) still skipped: ${skippedBlocks.join('; ')}`);
  // The selected shell runs a script at the exact spelling this suite hands out — the property that was
  // assumed before and is now measured.
  const probe = spawnSync(shell, [shPath(join(repoRoot, REHEARSAL))], {
    env: { ...process.env, PROJECTION_PHASE9_REHEARSAL_COMMAND: '' , PATH: '' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert(probe.error === undefined, `the selected shell could not be handed a repository path: ${probe.error?.message ?? ''}`);
  assert(probe.status !== 127,
    'the selected shell answered 127 for a script that exists, which is what a shell that cannot address '
    + 'this path does — the exact defect this selection was introduced to remove');
});

await h.finish();
