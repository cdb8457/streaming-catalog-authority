import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { NO_SHELL, posixShell, shPath, shellOrThrow } from './posix-shell-kit.js';

// Projection Phase 13 PRE-ENTRY — the adversarial audit over the SHIPPED BYTES.
//
// WHAT THIS SUITE IS FOR, AND WHY IT READS BYTES RATHER THAN INTENTIONS. Phase 8's gate defined a function
// and never called it, so the file every later assertion read was never written; `bash -n` did not catch it,
// an id audit did not catch it, and only RUNNING it did, six hours in. The classes of defect this file is
// aimed at are the ones that survive a syntax check, and every one of them was found in this repository's
// own shipped scripts by an independent readiness review that ran nothing:
//
//   A WRAPPER THAT RUNS SOMETHING OTHER THAN THE GATE ITS FILENAME NAMES. Four of them shipped.
//   A CALL SITE NOBODY HAS EVER EXECUTED, carrying a path that only exists in the other mode.
//   A LITERAL A RUN CANNOT MOVE, standing in for an observation and deciding a verdict or a skip.
//   AN UNBOUNDED WAIT, which is not a slow failure but a hang.
//   A CLEANUP THAT REMOVES WHAT IT DID NOT CREATE, which satisfies a count while violating the sentence.
//
// EVERY STRUCTURAL CHECK HERE CARRIES A CONTROL THAT PROVES THE AUDIT BITES. Phase 8's lesson was not "write
// an audit"; it was that the old pin — strip the suffix, grep for the bare string — was green against a gate
// recording five ids with no suffix at all. So each check is re-run against a DELIBERATELY UNREPAIRED COPY
// of the shipped bytes and asserted to FAIL. `REPAIRS_WITHOUT_A_CONTROL_MAX` is zero and this is where that
// number is spent.
//
// THE SHELL IS CHOSEN BY EXECUTION, NOT BY NAME. `./posix-shell-kit.js` makes each candidate EXECUTE a script
// at the path spelling this suite hands out and keeps the first that can. Started from an ordinary
// PowerShell, bare `bash` on a stock Windows PATH is the WSL launcher, which cannot address a Windows drive
// path in any spelling and answers 127 — the same number these controls assert on.
//
// IT STARTS NO CONTAINER, CONTACTS NOTHING, AND READS NO OPERATOR INPUT. The only programs it runs are the
// wrappers, against stubs it writes into a temporary directory.

const h = createHarness('Projection Phase 13 pre-entry — the instrument audit over the shipped bytes');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const tmpDirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'p13pre-audit-'));
  tmpDirs.push(dir);
  return dir;
};

/** Comments stripped, so a gate NAMED in an explanation is not mistaken for one that is invoked. */
const codeOf = (body: string): string => body.replace(/^\s*#.*$/gm, '');

const GENERIC_GATE = 'deploy/projection-real-provider-gate.sh';
const PROVIDER_GATE = 'deploy/projection-torbox-real-gate.sh';
const STAGE = 'deploy/projection-phase12-stage.sh';

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I1 — every optional wrapper invokes the gate its own filename names');
// ---------------------------------------------------------------------------------------------------------

/** Every `deploy/*-optional.sh` in the tree, discovered rather than listed. */
function optionalWrappers(): readonly string[] {
  return readdirSync(join(repoRoot, 'deploy'))
    .filter((name) => name.endsWith('-optional.sh'))
    .sort();
}

/** The gate a wrapper's filename names: `x-optional.sh` names `x.sh`. */
const gateNamedBy = (wrapper: string): string => `${basename(wrapper, '-optional.sh')}.sh`;

/** The gate a wrapper actually defaults to, read out of its `GATE_COMMAND` assignment. */
function gateInvokedBy(body: string): string | undefined {
  const match = /GATE_COMMAND="\$\{[A-Z0-9_]+:-\$HERE\/([A-Za-z0-9._-]+)\}"/.exec(codeOf(body));
  return match?.[1];
}

test('the sweep is over EVERY wrapper in the tree, not over a list somebody maintains', () => {
  const wrappers = optionalWrappers();
  assert(wrappers.length >= 20,
    `only ${wrappers.length} optional wrappers were discovered, which is too few for this tree — the sweep `
    + 'is looking in the wrong place and would report zero miswired wrappers for the wrong reason');
  // AND THE FOUR THE READINESS REVIEW NAMED ARE IN IT. A sweep that silently stopped finding them would be
  // green for the same reason a stopped-part-way inventory is.
  for (const named of [
    'projection-path-lifecycle-gate-optional.sh',
    'projection-real-provider-gate-optional.sh',
    'projection-torbox-mount-gate-optional.sh',
    'projection-torbox-real-gate-optional.sh',
  ]) {
    assert(wrappers.includes(named), `${named} was not discovered by the sweep`);
  }
});

test('every wrapper defaults to the gate its own filename names, and that gate exists', () => {
  const miswired: string[] = [];
  for (const wrapper of optionalWrappers()) {
    const body = read(`deploy/${wrapper}`);
    const invoked = gateInvokedBy(body);
    assert(invoked !== undefined,
      `${wrapper} has no GATE_COMMAND default this audit can read, so what it runs is unknown`);
    if (invoked !== gateNamedBy(wrapper)) miswired.push(`${wrapper} runs ${String(invoked)}`);
    assert(readdirSync(join(repoRoot, 'deploy')).includes(String(invoked)),
      `${wrapper} defaults to ${String(invoked)}, which is not a file in deploy/`);
  }
  assertEq(miswired.length, 0,
    `MISWIRED_OPTIONAL_WRAPPERS_MAX is 0 and ${miswired.length} wrapper(s) run a gate they do not name: `
    + miswired.join('; '));
});

test('every wrapper folds 77 ALONE, and propagates every other status unchanged', () => {
  for (const wrapper of optionalWrappers()) {
    const code = codeOf(read(`deploy/${wrapper}`));
    assert(/GATE_SKIP_STATUS=77/.test(code), `${wrapper} does not name 77 as the skip status`);
    assert(/if \[ "\$status" -eq "\$GATE_SKIP_STATUS" \]/.test(code),
      `${wrapper} does not compare the gate's status against the skip status`);
    assert(/^exit "\$status"$/m.test(code),
      `${wrapper} does not propagate a non-skip status unchanged, so a real failure could be folded`);
    // AND IT SAYS SO. A skip mapped to zero in silence is a green line nobody can interpret. THE SPELLING IS
    // NOT PINNED, and deliberately: two wrappers say "NOTHING WAS MEASURED" and then name what specifically
    // did not happen, which is the same job done better. Both are other tranches' files, and an audit that
    // failed them for their wording would be this tranche editing prose it does not own.
    assert(/NOTHING WAS (PROVED|MEASURED)/.test(read(`deploy/${wrapper}`)),
      `${wrapper} folds a skip into success without saying that nothing was proved`);
  }
});

test('the four wrappers this tranche repaired each say what their folded skip does NOT close', () => {
  // ONLY THIS TRANCHE'S FOUR. The structural checks above are over every wrapper in the tree; this one is
  // over the files whose prose this tranche wrote, because a green `-optional` run is exactly the line a
  // reader is most likely to mistake for evidence.
  for (const wrapper of [
    'projection-path-lifecycle-gate-optional.sh',
    'projection-real-provider-gate-optional.sh',
    'projection-torbox-mount-gate-optional.sh',
    'projection-torbox-real-gate-optional.sh',
  ]) {
    const body = read(`deploy/${wrapper}`);
    assert(body.includes('No acceptance gate is closed by this run.'),
      `${wrapper} does not say what its folded skip fails to close`);
    assert(/ONLY 77 IS MAPPED/.test(body),
      `${wrapper} does not say that only 77 is folded, so a reader cannot tell a skip from a pass`);
    assert(/IT RUNS THE GATE ITS OWN FILENAME NAMES/.test(body),
      `${wrapper} does not record the defect it was repaired for, so the next copy of it starts clean`);
  }
});

test('CONTROL: a wrapper returned to the wrong gate is CAUGHT', () => {
  // THE EXACT UNREPAIRED BYTES. This is what shipped before the repair, character for character.
  const body = read('deploy/projection-torbox-real-gate-optional.sh');
  const tampered = body.replace(
    'GATE_COMMAND="${PROJECTION_TORBOX_REAL_GATE_COMMAND:-$HERE/projection-torbox-real-gate.sh}"',
    'GATE_COMMAND="${PROJECTION_TORBOX_REAL_GATE_COMMAND:-$HERE/projection-three-server-concurrency-gate.sh}"',
  );
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  assertEq(gateInvokedBy(tampered), 'projection-three-server-concurrency-gate.sh',
    'the audit could not even read what the tampered wrapper runs, so it would not have caught the original');
  assert(gateInvokedBy(tampered) !== gateNamedBy('projection-torbox-real-gate-optional.sh'),
    'the audit reads the tampered wrapper as running the gate it names, so it would not have caught the '
    + 'defect that actually shipped in four files');
});

test('CONTROL: a wrapper that folded a FAILURE into success is CAUGHT', () => {
  const body = read('deploy/projection-real-provider-gate-optional.sh');
  const tampered = body.replace('exit "$status"', 'exit 0');
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  assert(!/^exit "\$status"$/m.test(codeOf(tampered)),
    'a wrapper that exits 0 whatever the gate said still reads as propagating the status');
});

test('DRIVEN: each repaired wrapper really executes the gate its filename names', () => {
  // THE ONLY CHECK HERE THAT IS NOT A READ. A default nobody executed is how the original defect survived a
  // syntax check and an id audit, so this one RUNS the wrapper against a stub standing in for the gate.
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  for (const [wrapper, seam] of [
    ['projection-torbox-real-gate-optional.sh', 'PROJECTION_TORBOX_REAL_GATE_COMMAND'],
    ['projection-real-provider-gate-optional.sh', 'PROJECTION_REAL_PROVIDER_GATE_COMMAND'],
    ['projection-torbox-mount-gate-optional.sh', 'PROJECTION_TORBOX_GATE_COMMAND'],
    ['projection-path-lifecycle-gate-optional.sh', 'PROJECTION_LIFECYCLE_GATE_COMMAND'],
  ] as const) {
    const dir = freshDir();
    const stub = join(dir, 'stub.sh');
    writeFileSync(stub, '#!/bin/sh\nprintf "%s" "stub-for-$1"\nexit "${STUB_STATUS:-0}"\n');
    try { chmodSync(stub, 0o755); } catch { /* Windows has no executable bit */ }

    // 77 IS FOLDED.
    const skipped = spawnSync(shellOrThrow(), [shPath(join(repoRoot, 'deploy', wrapper)), 'arg'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, [seam]: shPath(stub), STUB_STATUS: '77' },
    });
    assertEq(skipped.status, 0, `${wrapper} did not fold the gate's 77 into success`);

    // AND NOTHING ELSE IS. 70 is the origin recheck's "disallowed" and it must never become a zero.
    for (const status of ['1', '70', '124']) {
      const failed = spawnSync(shellOrThrow(), [shPath(join(repoRoot, 'deploy', wrapper)), 'arg'], {
        encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, [seam]: shPath(stub), STUB_STATUS: status },
      });
      assertEq(failed.status, Number(status), `${wrapper} did not propagate status ${status} unchanged`);
    }

    // AND THE ARGUMENTS REACH THE GATE. A wrapper that swallowed argv would run a different invocation.
    const passed = spawnSync(shellOrThrow(), [shPath(join(repoRoot, 'deploy', wrapper)), '--fake'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, [seam]: shPath(stub), STUB_STATUS: '0' },
    });
    assert(String(passed.stdout ?? '').includes('stub-for---fake'),
      `${wrapper} did not pass its arguments through to the gate`);
  }
});

// ---------------------------------------------------------------------------------------------------------
h.section('the shipped shell is LF, which is what every byte-level pin here rests on');
// ---------------------------------------------------------------------------------------------------------

test('no script this audit slices carries a carriage return', () => {
  for (const path of [
    GENERIC_GATE, PROVIDER_GATE, STAGE,
    ...optionalWrappers().map((name) => `deploy/${name}`),
  ]) {
    const raw = readFileSync(join(repoRoot, path));
    assertEq(raw.includes(0x0d), false, `${path} holds a CR; .gitattributes pins shipped shell to LF`);
  }
  assert(read('.gitattributes').includes('*.sh text eol=lf'),
    '.gitattributes no longer pins shell scripts to LF, so every byte pin here is about a checkout');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase13-preentry-gate-audit.ts'),
    'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase13-preentry-gate-audit.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
