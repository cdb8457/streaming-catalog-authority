import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';

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

/** Whether this host has a bash the audit can actually drive. Windows without Git Bash has none. */
function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_BASH = bashAvailable();

interface RunResult { readonly status: number; readonly output: string }

function runBash(script: string, env: Record<string, string>): RunResult {
  // stderr is FOLDED INTO stdout deliberately. Every one of these wrappers writes its refusals and its
  // "NOTHING WAS PROVED" to stderr, which is correct — and a harness that only captured stdout would report
  // a silent fold as a silent fold, which is the assertion, so it has to read both.
  const command = `"${join(repoRoot, script).replace(/\\/g, '/')}" 2>&1`;
  try {
    const output = execFileSync('bash', ['-c', command], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/** A stub that exits with a scripted status, so the wrappers' ACCOUNTING is driven rather than read. */
function withStub(status: number, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'phase9-stub-'));
  const path = join(dir, 'stub.sh');
  try {
    writeFileSync(path, `#!/usr/bin/env bash\necho "stub ran"\nexit ${status}\n`, 'utf8');
    chmodSync(path, 0o755);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

h.section('syntax, which is necessary and nowhere near sufficient');

test('every rehearsal script parses', () => {
  if (!HAS_BASH) { console.log('    (skipped: no bash on this host)'); return; }
  for (const script of [REHEARSAL, OPTIONAL, THREE]) {
    execFileSync('bash', ['-n', join(repoRoot, script)], { stdio: 'ignore' });
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
  if (!HAS_BASH) { console.log('    (skipped: no bash on this host)'); return; }
  withStub(77, (stub) => {
    const result = runBash(OPTIONAL, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub });
    assertEq(result.status, 0, 'a skip was not folded');
    assert(result.output.includes('NOTHING WAS PROVED'), 'the fold was silent');
    assert(result.output.includes('as open as'), 'the fold did not say the phase is still open');
  });
});

test('the optional wrapper passes a REAL FAILURE through unchanged', () => {
  if (!HAS_BASH) { console.log('    (skipped: no bash on this host)'); return; }
  withStub(1, (stub) => {
    assertEq(runBash(OPTIONAL, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub }).status, 1,
      'a rehearsal that RAN AND FAILED was folded into success');
  });
  withStub(3, (stub) => {
    assertEq(runBash(OPTIONAL, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub }).status, 3, 'an unusual status');
  });
});

test('the optional wrapper passes a PASS through as a pass', () => {
  if (!HAS_BASH) { console.log('    (skipped: no bash on this host)'); return; }
  withStub(0, (stub) => {
    const result = runBash(OPTIONAL, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub });
    assertEq(result.status, 0, 'a pass');
    assert(!result.output.includes('NOTHING WAS PROVED'), 'a pass was reported as a skip');
  });
});

test('the three-runner runs exactly three times and counts them', () => {
  if (!HAS_BASH) { console.log('    (skipped: no bash on this host)'); return; }
  withStub(0, (stub) => {
    const result = runBash(THREE, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub });
    assertEq(result.status, 0, 'three passing runs did not pass');
    assertEq((result.output.match(/stub ran/g) ?? []).length, 3, 'the runner did not run three times');
    assert(result.output.includes('3 of 3 consecutive'), 'the runner did not count');
    assert(result.output.includes('CLOSES NO PART OF PHASE 9'), 'three rehearsals were reported as a closure');
  });
});

test('the three-runner STOPS at the first failure and reports how far it got', () => {
  if (!HAS_BASH) { console.log('    (skipped: no bash on this host)'); return; }
  withStub(1, (stub) => {
    const result = runBash(THREE, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub });
    assertEq(result.status, 1, 'a failing run did not fail the sequence');
    assertEq((result.output.match(/stub ran/g) ?? []).length, 1, 'the runner continued past a failure');
    assert(result.output.includes('Runs completed: 0 of 3'), 'the runner did not say how far it got');
  });
});

test('the three-runner PROPAGATES a skip as a skip rather than folding it', () => {
  if (!HAS_BASH) { console.log('    (skipped: no bash on this host)'); return; }
  withStub(77, (stub) => {
    const result = runBash(THREE, { PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT: stub });
    assertEq(result.status, 77, 'a skipped run was folded inside the three-runner');
    assert(result.output.includes('THIS SEQUENCE PROVES NOTHING'), 'the skip was quiet');
  });
});

test('A ZERO-RUN LOOP CANNOT ANNOUNCE A COMPLETED SEQUENCE', () => {
  if (!HAS_BASH) { console.log('    (skipped: no bash on this host)'); return; }
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
  if (!HAS_BASH) { console.log('    (skipped: no bash on this host)'); return; }
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

await h.finish();
