import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseShellSource, ShellSourceError } from './helpers/shell-source.js';

// Projection Phase 2 — the mount-hardening gates, offline.
//
// WHAT THIS SUITE IS FOR. The three Phase 2 gates — serve-death, stale-mount and sustained-outage — need
// Docker, /dev/fuse, a real PostgreSQL and the daemon; they run as `npm run go:<gate>:three` on a host that
// can host them. This suite runs everywhere in seconds and pins the rules those gates depend on: that the
// scripts exist and are wired, that every heredoc is quoted (an unquoted heredoc would run `$(...)` inside a
// gate that claims to be about a controlled experiment), that a skip is 77 and never a pass, that cleanup
// happens through the shared helper on every exit path, and that the gates do NOT duplicate Phase 1.
//
// WHY THE NON-OVERLAP CLAIM IS TESTED HERE AND NOT JUST WRITTEN. The Phase 1 acceptance plan is the
// repository's authority on what G1-G27 mean, and a Phase 2 gate that silently re-tested a Phase 1 property
// would be a gate that could "pass" without adding evidence. Each new gate's header names the Phase 1
// coverage it is deliberately NOT repeating, and this suite holds those headers to it.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

/**
 * Blocks this suite could not execute here, counted so a green summary cannot hide them.
 *
 * A TEST THAT RETURNS EARLY STILL PRINTS `PASS`. One test below EXECUTES a shipped embedded program against a
 * stub on PATH, which needs POSIX process semantics; without this a Windows reader would see it green and
 * have no way to know the half that runs the program never ran.
 */
const skippedBlocks: string[] = [];
const skipBlock = (what: string): void => {
  skippedBlocks.push(what);
  console.log(`  ..  SKIPPED on ${process.platform}: ${what}`);
};

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1; console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1; failures.push([name, error]); console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

console.log('Projection Phase 2 — mount-hardening gates (offline)');

// ---------------------------------------------------------------------------------------------------------
// The ship set: three gates, three wrappers, three optional entry points, three Compose files.
// ---------------------------------------------------------------------------------------------------------

const GATES = ['serve-death', 'stale-mount', 'sustained-outage'] as const;
const scripts = GATES.flatMap((gate) => [`deploy/projection-${gate}-gate.sh`,
  `deploy/projection-${gate}-gate-three.sh`, `deploy/projection-${gate}-gate-optional.sh`]);
const compose = GATES.map((gate) => `docker-compose.projection-${gate}.yml`);

test('THE PHASE 2 GATES EXIST, and each is a bash script with the gate skeleton', () => {
  for (const gate of GATES) {
    const text = read(`deploy/projection-${gate}-gate.sh`);
    assert(text.startsWith('#!/usr/bin/env bash'), `${gate}: the gate is not a bash script`);
    assert(text.includes('set -euo pipefail'), `${gate}: the gate does not fail closed`);
    assert(text.includes('GATE_ROOT='), `${gate}: the gate has no gate home`);
    assert(text.includes('$WORK/out'), `${gate}: the gate never reports under $WORK/out`);
  }
  for (const wrapper of scripts.filter((script) => script.includes('-three.sh'))) {
    const text = read(wrapper);
    assert(text.startsWith('#!/usr/bin/env bash'), `${wrapper} is not a bash script`);
    assert(text.includes('for round in 1 2 3'), `${wrapper} does not run three cold starts`);
  }
});

test('EACH GATE HAS ITS OWN COMPOSE FILE, and none of them is the deployment shape to copy', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  for (const gate of GATES) {
    const file = `docker-compose.projection-${gate}.yml`;
    const text = read(file);
    assert(text.includes(`name: projection-${gate}-gate`), `${file} is not its own project`);
    assert(text.includes('postgres'), `${file} has no throwaway database`);
    assert(!text.includes('projectiond:'), `${file} builds the daemon, which the gate itself must run`);
  }
  assert(pkg.scripts[`go:${GATES[0]}-gate`] !== undefined, 'the gates are wired');
});

// ---------------------------------------------------------------------------------------------------------
// Heredoc closure. The gates write their probe programs and fixtures with `cat > "$WORK/..." <<'DELIM'`.
// An UNQUOTED heredoc would expand `$(...)` and `$WORK` at write time — real execution where the gate wants
// to hand bytes to a later run — so every heredoc operator in every gate must be quoted.
// ---------------------------------------------------------------------------------------------------------

test('EVERY HEREDOC IN THE NEW GATES IS QUOTED, and the shared reader accepts the whole script', () => {
  for (const script of scripts) {
    const text = read(script);
    const unquoted = [...text.matchAll(/<<([A-Za-z0-9_]+)/g)];
    assert(unquoted.length === 0,
      `${script}: an unquoted heredoc would run its body at write time: <<${unquoted[0]?.[1] ?? ''}`);
    const dashed = [...text.matchAll(/<<-([A-Za-z0-9_]+)/g)];
    assert(dashed.length === 0,
      `${script}: a dashed heredoc is still unquoted: <<-${dashed[0]?.[1] ?? ''}`);
    try {
      parseShellSource(text, script).lines.length;
    } catch (error) {
      assert(!(error instanceof ShellSourceError), `${script}: ${(error as ShellSourceError).message}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------
// The skip contract. A host without /dev/fuse cannot host these gates; that is a skip, and a skip is 77,
// never 0. The `-optional` entry point is the ONLY place 77 is folded, and it must say it proved nothing.
// ---------------------------------------------------------------------------------------------------------

test('A GATE THAT CANNOT HOST ITSELF SKIPS WITH 77, and the -optional entry point is the only 77 folder', () => {
  for (const gate of GATES) {
    const gateText = read(`deploy/projection-${gate}-gate.sh`);
    assert(gateText.includes('GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"'),
      `${gate}: the skip status is configurable and defaults to 77`);
    assert(gateText.includes('exit "$GATE_SKIP_STATUS"'), `${gate}: a skip exits 77, never 0`);
    const optional = read(`deploy/projection-${gate}-gate-optional.sh`);
    assert(optional.includes('GATE_SKIP_STATUS=77'), `${gate}-optional maps 77`);
    assert(optional.includes('NOTHING WAS PROVED'), `${gate}-optional says a folded skip proved nothing`);
    assert(optional.includes('exit 0'), `${gate}-optional folds 77 to 0`);
    assert(optional.includes('exit "$status"'), `${gate}-optional propagates every other status`);
    assert(!optional.includes('GATE_COMMAND=projectiond') && optional.includes('GATE_COMMAND'),
      `${gate}-optional runs the real gate, not a stand-in`);
  }
  // The direct entry point does NOT fold 77: the required evidence invocation must FAIL where it cannot run.
  assert(!read(`deploy/projection-${GATES[0]}-gate.sh`).includes('77 && exit 0'),
    'the gate itself never folds its own skip');
});

// ---------------------------------------------------------------------------------------------------------
// The three-consecutive-fresh-run wrappers. A run that skips is a FAILURE for the runner, and a crashed
// prior run's container or network is refused BEFORE the run directory is removed: the cleanup trap in the
// gate owns the directory, and deleting it out from under a still-alive container would disturb the very
// gate the runner claims it is leaving alone.
// ---------------------------------------------------------------------------------------------------------

test('THE -three WRAPPER REFUSES A LIVE PRIOR GATE BEFORE TOUCHING ITS RUN DIRECTORY', () => {
  for (const gate of GATES) {
    const wrapper = read(`deploy/projection-${gate}-gate-three.sh`);
    assert(wrapper.includes('for round in 1 2 3'), `${gate}-three runs the gate three times`);
    const check = wrapper.indexOf('docker ps --filter "name=projection-');
    const rm = wrapper.indexOf('rm -rf "$GATE_ROOT"');
    assert(check !== -1 && rm !== -1, `${gate}-three must check for a live prior gate and clean its root`);
    assert(check < rm, `${gate}-three removes the run directory BEFORE checking for a live prior container`);
    assert(wrapper.includes('exit 1'), `${gate}-three refuses rather than colliding`);
  }
});

test('THE -three WRAPPER COUNTS A SKIP AS A FAILURE, and only three passes exit 0', () => {
  for (const gate of GATES) {
    const wrapper = read(`deploy/projection-${gate}-gate-three.sh`);
    assert(wrapper.includes('[ "$RC" -eq 77 ]') && wrapper.includes('a skipped gate is not a pass for the runner'),
      `${gate}-three does not let a silent skip count as a pass`);
    assert(wrapper.includes('RESULT: PASSED three consecutive cold-start runs'),
      `${gate}-three only exits 0 after three full passes`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Cleanup through the shared helper, on every exit path. The reader goes first: a FUSE mount with a live
// reader does not unmount cleanly.
// ---------------------------------------------------------------------------------------------------------

test('THE GATES CLEAN UP THROUGH THE SHARED HELPER, on every exit path', () => {
  for (const gate of GATES) {
    const text = read(`deploy/projection-${gate}-gate.sh`);
    assert(text.includes('projection-gate-cleanup.sh'), `${gate}: it sources the shared cleanup`);
    assert(text.includes('projection_gate_cleanup_run'), `${gate}: and calls it`);
    assert(text.includes('projection_gate_report_cleanliness'), `${gate}: and reports what it left`);
    assert(text.includes('trap cleanup EXIT'), `${gate}: on success, failure and interrupt alike`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Non-overlap with Phase 1. The Phase 1 acceptance plan is the authority on what G1-G27 cover, and the
// Phase 2 gates must not silently re-test it. Each gate's header names the Phase 1 coverage it is NOT
// repeating, and this suite holds those names to the plan.
// ---------------------------------------------------------------------------------------------------------

const PHASE1 = read('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');

test('THE SERVE-DEATH GATE DOES NOT RE-TEST G7-G9: the process lives the whole time', () => {
  const text = read('deploy/projection-serve-death-gate.sh');
  assert(/WHY IT IS NOT G7-G9/.test(text), 'the header names the Phase 1 coverage it is not');
  assert(text.includes('leaves the process alive the whole time'),
    'serve-death is about a serve loop dying under a living process, which G7-G9 never arrange');
  assert(/A daemon that always exited 0 on a serve death would pass G7-G9 and fail this gate/.test(text),
    'and it says what the difference buys');
});

test('THE STALE-MOUNT GATE DOES NOT RE-TEST G7-G9: it faces the corpse at startup', () => {
  const text = read('deploy/projection-stale-mount-gate.sh');
  assert(/WHY IT IS NOT G7-G9/.test(text), 'the header names the Phase 1 coverage it is not');
  assert(text.includes('the new process stacks over the corpse'),
    'G7-G9 prove the mount SURVIVES a process death; the stale-mount gate names the corpse itself');
  assert(/Both halves are the probe/.test(text),
    'and both phases are one probe, not a restart test');
});

test('THE SUSTAINED-OUTAGE GATE DOES NOT RE-TEST G26: it is the breaker, not a short-lived fault', () => {
  const text = read('deploy/projection-sustained-outage-gate.sh');
  assert(text.includes('G26 already covers short-lived faults'),
    'the header names the Phase 1 coverage it is not');
  assert(text.includes('an endpoint that is STILL down after five counted failures'),
    'sustained-outage is about an endpoint that is STILL down after five counted failures');
  assert(text.includes('NO DAEMON CHANGE') || text.includes('no daemon change'),
    'and it is evidence over existing product behaviour, exactly like G24-G26');
});

test('NO PHASE 2 GATE CLAIMS A PHASE 1 G-NUMBER AS ITS OWN, and the plan does not claim a Phase 2 gate exists yet', () => {
  // Every G-number the gates mention is in an explicit "WHY IT IS NOT" / "already covers" frame. A bare
  // "G24 asserts…" or "this gate is G27" would be a Phase 2 gate stealing a Phase 1 number.
  for (const gate of GATES) {
    const text = read(`deploy/projection-${gate}-gate.sh`);
    for (const match of text.matchAll(/\bG(?:1[0-9]|[1-9])\b/g)) {
      const at = match.index as number;
      const line = text.slice(Math.max(0, text.lastIndexOf('\n', at)), text.indexOf('\n', at));
      assert(/NOT G[0-9]|already (covers|watch)|Phase 1|G7-G9|G24-G26/.test(line),
        `deploy/projection-${gate}-gate.sh cites ${match[0]} as its own claim; Phase 1 owns the G-numbers`);
    }
  }
  // The Phase 1 plan must not be forced to carry Phase 2 claims: Phase 2 gates are not in it.
  assert(!/serve-death-gate|stale-mount-gate|sustained-outage-gate/.test(PHASE1),
    'the Phase 1 acceptance plan already names a Phase 2 gate');
});

// ---------------------------------------------------------------------------------------------------------
// The wiring, exactly as the acceptance plan names it: the evidence command is the :three wrapper, and a
// host that cannot host the gate FAILS rather than quietly passing.
// ---------------------------------------------------------------------------------------------------------

test('THE EVIDENCE COMMAND IS THE :three WRAPPER, and it propagates 77', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  for (const gate of GATES) {
    assertEq(pkg.scripts[`go:${gate}-gate:three`], `bash deploy/projection-${gate}-gate-three.sh`,
      `${gate}-three is wired as the acceptance invocation`);
    assert(!read(`deploy/projection-${gate}-gate-three.sh`).includes('exit 0 # folded 77'),
      `${gate}-three never folds a skip`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// THE ROADMAP AND THE RUN RECORDS MUST AGREE, AND THAT IS THE FAILURE THIS REPOSITORY EXISTS TO PREVENT.
//
// Phase 1 spent four separate dispatches removing present-tense claims that a gate did not exist from
// documents and from shipped wrappers that PRINTED them, after the gate had run. Phase 2 starts from the
// mirror image of that risk: three gates that exist and have never run, described by a document with three
// empty run records and a roadmap row that has to keep saying so. So the two are pinned to each other rather
// than each being trusted to stay honest on its own.
// ---------------------------------------------------------------------------------------------------------

const PHASE2 = read('docs/PROJECTION_PHASE_2_MOUNT_HARDENING.md');
const ROADMAP = read('docs/PROJECTION_ROADMAP.md');
const flat = (text: string): string => text.replace(/\s+/g, ' ');

test('THE ROADMAP NAMES PHASE 2 AND ITS DOCUMENT, and retires the sentence that denied both', () => {
  assert(ROADMAP.includes('docs/PROJECTION_PHASE_2_MOUNT_HARDENING.md'),
    'the roadmap does not name the Phase 2 document, so the gates are an orphan tranche');
  const row = ROADMAP.split('\n').find((line) => line.startsWith('| **Projection Phase 2**'));
  assert(row !== undefined, 'the tranche table has no Projection Phase 2 row');

  // The sentence that used to end the tranche section is allowed ONLY as history. Left standing in the
  // present tense it would be a roadmap denying the existence of three scripts in the same repository.
  for (const match of ROADMAP.matchAll(/There is no Phase 2 in this document/g)) {
    const before = flat(ROADMAP.slice(Math.max(0, (match.index as number) - 200), match.index as number));
    assert(/HISTORICALLY/.test(before),
      'the roadmap still denies Phase 2 exists in the present tense');
  }
});

test('WHILE EVERY RUN RECORD SAYS NOT RUN, NO DOCUMENT MAY SAY OTHERWISE', () => {
  // One marker per gate. A gate that has run replaces its own, and only its own.
  const markers = PHASE2.match(/\*\*NOT RUN\.\*\*/g) ?? [];
  assertEq(markers.length, GATES.length, 'each gate must carry its own NOT RUN marker until it has run');

  // Three placeholder rows per gate, and PLACEHOLDER is the assertion: a row with a host in it is a claim,
  // and a claim in this table while the marker above it still says NOT RUN is the contradiction.
  const rows = (PHASE2.match(/^\| [123]\/3 \|.*$/gm) ?? []).map((row) => row.trim());
  assertEq(rows.length, GATES.length * 3, 'three run-record rows per gate');
  for (const row of rows) {
    assert(/^\| [123]\/3 \|( — \|){5}$/.test(row), `a run record is filled while its gate says NOT RUN: ${row}`);
  }

  // ...and the roadmap counts those nine absent runs rather than describing them.
  const row = ROADMAP.split('\n').find((line) => line.startsWith('| **Projection Phase 2**')) ?? '';
  assert(row.includes('**Open'), 'the Phase 2 row must read Open while no gate has run');
  assert(/0 of the 9 fresh runs/.test(row),
    'the Phase 2 row must count the runs that have not happened, not characterise them');
  for (const stale of [/Phase 2[^.|]{0,40}\*\*Done\*\*/i, /Phase 2 closes/i,
    /3\/3[^.|]{0,60}(serve-death|stale-mount|sustained-outage)/i]) {
    assert(!stale.test(flat(ROADMAP)), `the roadmap claims a Phase 2 run that has not happened: ${String(stale)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// THE DAEMON HALF. Two of the three gates drive product code that Phase 1 did not have, and a gate can only
// prove what the product exposes: the supervisor branches on UnmountRequested, so that accessor and the
// ordering behind it are what the serve-death gate actually measures. Pinned here because it is a source
// property that costs nothing to check everywhere, and a rename would otherwise be found on the host.
// ---------------------------------------------------------------------------------------------------------

test('THE SUPERVISOR OBSERVES A SERVE DEATH WHILE THE PROCESS LIVES, and the mount handle can tell it apart', () => {
  const main = read('projectiond/cmd/projectiond/main.go');
  const fusefs = read('projectiond/internal/fusefs/fusefs.go');
  for (const accessor of ['Done()', 'UnmountRequested()', 'ServeErr()']) {
    assert(main.includes('mount.' + accessor), `the supervisor does not consult ${accessor}`);
    assert(fusefs.includes('func (m *Mounted) ' + accessor.replace('()', '(')),
      `Mounted does not expose ${accessor}, so the supervisor cannot compile`);
  }
  // The discriminator is the flag, and Unmount must set it BEFORE it asks the kernel to detach. Inverted,
  // every clean SIGTERM is reported as a serve-loop death and --serve-exit-code fails a graceful stop.
  const unmount = fusefs.slice(fusefs.indexOf('func (m *Mounted) Unmount()'));
  const store = unmount.indexOf('m.graceful.Store(true)');
  const detach = unmount.indexOf('m.server.Unmount()');
  assert(store >= 0 && detach >= 0, 'Unmount no longer records the request it is making');
  assert(store < detach, 'Unmount asks the kernel to detach before recording that it asked, so a graceful ' +
    'unmount can be misclassified as a serve-loop death');
  // And the classification is a named function so a test can drive it rather than imitate it.
  assert(/func \(m \*Mounted\) recordServeExit\(\)/.test(fusefs),
    'the serve-exit classification is inlined, so no off-host test can drive the shipped decision');
  assert(read('projectiond/internal/fusefs/serve_linux_test.go').includes('m.recordServeExit()'),
    'no test drives the shipped serve-exit classification');
});

// ---------------------------------------------------------------------------------------------------------
// THREE DEFECTS FOUND BY READING THE GATES, EACH PINNED BY THE PROPERTY THAT WAS MISSING RATHER THAN BY THE
// TEXT THAT NOW FIXES IT. All three are the class this repository keeps finding: a step whose success does
// not depend on the thing it claims to measure.
// ---------------------------------------------------------------------------------------------------------

test('A GATE RUNS ALL OF ITSELF: no phase of a Phase 2 gate is behind a default-off switch', () => {
  // The stale-mount gate shipped with `REFUSE_STALE=${...:-0}` and no caller passing it, so the evidence
  // command ran the stacking half and never once executed the refusal — while its own document said both
  // halves face the same corpse. A gate whose coverage depends on how it was invoked is a gate whose
  // coverage is unknown, so the whole class is refused: no phase gating on an argument or an environment
  // variable, in any of the three.
  for (const gate of GATES) {
    const text = read(`deploy/projection-${gate}-gate.sh`);
    const body = text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    // A positional compared against a literal `--flag` is the shape that did this: `[ "${1:-}" = "--refuse-stale" ]`.
    // Positionals inside a function are that function's parameters and are not the script's invocation.
    assert(!/\$\{?[0-9](?::-[^}]*)?\}?"?\s*=\s*"--/.test(body),
      `${gate}: a phase is selected by a command-line flag, so the evidence command may run only part of it`);
    for (const match of body.matchAll(/\$\{([A-Z_]+):-([^}]*)\}/g)) {
      const name = match[1] ?? '';
      const fallback = match[2] ?? '';
      assert(!/PHASE|REFUSE|SKIP_PHASE|ONLY/.test(name) || fallback === '1',
        `${gate}: ${name} defaults to '${fallback}', which lets the evidence command skip a phase`);
    }
  }
  // ...and the stale-mount gate specifically runs both halves, in order, against the one corpse.
  const stale = read('deploy/projection-stale-mount-gate.sh');
  const phase1 = stale.indexOf('step "phase 1 (default)');
  const phase2 = stale.indexOf('step "phase 2 (--refuse-stale)');
  assert(phase1 > 0 && phase2 > phase1, 'the stale-mount gate must run phase 1 then phase 2 unconditionally');
  assert(stale.slice(phase2).includes('corpse_is_stale'),
    'phase 2 must re-verify the corpse, or it cannot claim to face the same one');
});

test('EVERY WAIT ON A DAEMON THAT MUST EXIT IS BOUNDED, so the regression fails the gate instead of hanging it', () => {
  // `docker wait` on a container that never exits blocks forever. The one place it was used on a daemon whose
  // EXIT is the assertion — the --refuse-stale daemon — meant that a daemon which served instead of refusing
  // hung the gate rather than failing it. A gate that hangs on the defect it is hunting reports nothing.
  for (const gate of GATES) {
    const text = read(`deploy/projection-${gate}-gate.sh`);
    for (const [index, line] of text.split('\n').entries()) {
      if (line.trimStart().startsWith('#') || !/\bdocker wait\b/.test(line)) continue;
      // A bounded use is one whose failure is tolerated: the wait is a courtesy and a separate polling loop
      // or inspect carries the assertion. An unguarded `docker wait` whose output IS the verdict is not.
      assert(/\|\|\s*true/.test(line) && !/^\s*[A-Z_]+="\$\(docker wait/.test(line),
        `deploy/projection-${gate}-gate.sh:${index + 1} takes its verdict from an unbounded docker wait`);
    }
  }
  const stale = read('deploy/projection-stale-mount-gate.sh');
  assert(/REFUSE_TIMEOUT_TICKS/.test(stale) && /still running after/.test(stale),
    'the --refuse-stale wait must be bounded and say what it means when the bound is hit');
});

test('NO GATE READS DOCKER RUN\'S OWN REFUSAL AS THE MOUNT\'S OR THE DAEMON\'S ANSWER', () => {
  // `docker run` reports its own failure to start with 125/126/127, before the image runs an instruction. A
  // step that treats "non-zero" as "the surface refused me" therefore passes when nothing was consulted —
  // the defect the Phase 1 review found four times over in the TorBox gate's read-only refusals, and once
  // here in the post-exit status probe. The fix is that the PROBE prints its own verdict and the gate
  // demands that token, so docker's refusal is a third outcome rather than a silent pass.
  // Every probe whose FAILURE is the evidence has to say so itself. Both of these were found reading
  // "non-zero" as a product refusal: the serve-death gate's post-exit status probe, and the sustained-outage
  // gate's `read_block`, where a docker that could not start would have scored the entire hold phase as
  // reads failing fast with zero provider traffic — a textbook outage over a container that never ran.
  const verdicts: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['serve-death', ['probe:answered', 'probe:unreachable']],
    ['sustained-outage', ['read:ok', 'read:eio']],
  ];
  for (const [gate, tokens] of verdicts) {
    const text = read(`deploy/projection-${gate}-gate.sh`);
    for (const token of tokens) {
      assert(text.includes(token),
        `${gate}: the probe does not emit '${token}', so it cannot tell a product refusal from a failed start`);
    }
    // ...and the third outcome is handled explicitly. A two-branch dispatch on a verdict silently folds
    // "never ran" into whichever branch is the fallthrough, which is the defect wearing a different hat.
    for (const match of text.matchAll(/case "\$[A-Za-z_]+" in\n([\s\S]*?)\besac/g)) {
      const block = match[1] ?? '';
      if (!tokens.some((token) => block.includes(token))) continue;
      assert(/^\s*\*\)/m.test(block),
        `${gate}: a verdict dispatch has no catch-all, so a probe that never ran is scored as one that did`);
    }
  }
  assert(!/^if docker run --rm --network "container:\$MOUNT_CONTAINER"/m.test(
    read('deploy/projection-serve-death-gate.sh')),
  'the post-exit status check is back to branching on docker run\'s exit status');
  // The timed helper must refuse a measurement it did not take, rather than returning a fast elapsed time.
  const outage = read('deploy/projection-sustained-outage-gate.sh');
  assert(/never ran \(docker refused it\)/.test(outage),
    'timed_read_fail no longer distinguishes a read that failed from a probe that never ran');
});

test('THE SERVE-DEATH POLLER PROVES AN ORDER, not a population of samples', () => {
  // `ready_ok >= 2` was described as "ready before and after the death" and satisfied by two ready samples
  // half a second apart BEFORE it — so a daemon that died and never came back passed the assertion whose
  // entire purpose was to catch that. What must hold is a sequence.
  const text = read('deploy/projection-serve-death-gate.sh');
  assert(/ready_seq=/.test(text), 'the poller no longer records a transition sequence');
  assert(/RDR/.test(text), 'the gate does not require ready -> not-ready -> ready');
  assert(!/PROBE_OK"\s+-ge 2/.test(text),
    'the gate is back to counting ready samples, which cannot distinguish "came back" from "never left"');
});

// ---------------------------------------------------------------------------------------------------------
// THE EMBEDDED PROGRAM IS EXECUTED, NOT JUST READ.
//
// PHASE 1 SPENT FOUR DISPATCHES ON THIS EXACT GAP: programs written into gates through heredocs, checked by
// tests that only ever grepped them, and found — once something finally ran them — to contain defects that
// made a gate's own success unfailable. `readyz-probe.sh` is a new program of that kind and the only one in
// Phase 2 with real logic: it collapses a stream of samples into a transition string, and the gate's verdict
// is that string. A regex over the gate would pass against a state machine that never emits `D`.
//
// SO THE SHIPPED PROGRAM IS EXTRACTED FROM THE GATE AND RUN, against a stub `wget` that plays a scripted
// sequence of ready/not-ready answers. Running it needs a PATH-injected executable and POSIX process
// semantics, which win32 does not provide; there the block SKIPS and says so rather than printing green.
// ---------------------------------------------------------------------------------------------------------

/**
 * A POSIX shell that can actually execute a script here, CHOSEN BY RUNNING ONE.
 *
 * THIS SUITE DOES NOT KEY THE DECISION ON `process.platform`, and that is a lesson this repository paid for:
 * `d4f3265` records a Windows figure published twice that was never measured, because the suite picked its
 * shell by name and PATH order decided whether anything was checked. A name is a guess; an execution is not.
 * So a candidate is accepted only after it has run a script that prints a token.
 */
function workingShell(): string | undefined {
  for (const candidate of ['sh', 'bash', 'C:/Program Files/Git/usr/bin/sh.exe']) {
    const probe = spawnSync(candidate, ['-c', 'echo shell:ok'], { encoding: 'utf8', timeout: 20_000 });
    if (probe.error === undefined && probe.status === 0 && probe.stdout.includes('shell:ok')) return candidate;
  }
  return undefined;
}

/**
 * A path spelled the way the SHELL will read it, which on Windows is not the way the platform stores it.
 *
 * `C:/x` in a PATH is TWO entries to a POSIX shell, because `:` is the separator — which is exactly why a
 * PATH-injected stub silently fails to be found rather than failing loudly. `/c/x` is the spelling that works.
 */
const shPath = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_m, drive: string) => `/${drive.toLowerCase()}/`);

/** The probe exactly as the gate writes it, taken from the gate rather than restated. */
function extractReadyzProbe(): string {
  const gate = read('deploy/projection-serve-death-gate.sh');
  const open = gate.indexOf("cat > \"$WORK/readyz-probe.sh\" <<'PROBE'\n");
  assert(open >= 0, 'the serve-death gate no longer writes readyz-probe.sh through a quoted heredoc');
  const start = gate.indexOf('\n', open) + 1;
  const end = gate.indexOf('\nPROBE\n', start);
  assert(end > start, 'the readyz-probe heredoc does not terminate');
  return gate.slice(start, end);
}

test('THE SHIPPED READYZ PROBE IS RUN, and it reports the order it actually observed', () => {
  const probe = extractReadyzProbe();
  // Read-only properties first, so win32 still checks something real about the shipped text.
  assert(probe.includes('ready_seq='), 'the probe does not report a transition sequence');
  assert(/case "\$seq" in RDR\*\) break/.test(probe), 'the probe does not stop once the recovery is whole');

  const shell = workingShell();
  if (shell === undefined) {
    skipBlock('executing the shipped readyz-probe against a stub `wget` '
      + '(no POSIX shell on this host could execute a script)');
    return;
  }

  // The stub answers ready, ready, NOT ready, NOT ready, then ready — one death and one recovery. Each call
  // consumes one line of the script, so the probe sees a real sequence rather than a constant.
  const dir = mkdtempSync(join(tmpdir(), 'serve-death-probe-'));
  writeFileSync(join(dir, 'plan'), 'R\nR\nD\nD\nR\n');
  const stub = join(dir, 'wget');
  writeFileSync(stub, [
    '#!/bin/sh',
    // Pop the next planned answer. A plan that runs out answers not-ready, which would show up as a
    // sequence that never returns to R — a failure, not a silent pass.
    'next="$(head -n 1 "$PLAN" 2>/dev/null)"',
    'tail -n +2 "$PLAN" > "$PLAN.rest" 2>/dev/null && mv "$PLAN.rest" "$PLAN"',
    '[ "$next" = "R" ] || exit 1',
    'echo \'{"ready":true}\'',
  ].join('\n') + '\n');
  chmodSync(stub, 0o755);

  const script = join(dir, 'readyz-probe.sh');
  writeFileSync(script, probe);
  // THE STUB IS PUT ON PATH BY THE SHELL, NOT BY THE PARENT'S ENVIRONMENT, and the distinction is load-bearing
  // on Windows. A POSIX shell splits PATH on `:`, so a Windows PATH reaches it as nonsense and the stub is
  // never found — the probe then reports "never ready", which looks exactly like the regression under test.
  // Rewriting PATH in the child's env instead breaks the other end: Node needs the platform's own PATH to
  // locate `sh` at all, and rewriting it makes the spawn itself fail with ENOENT. Prepending inside the shell
  // avoids both, because `$PATH` there is already in the spelling that shell uses.
  const run = spawnSync(shell, ['-c',
    `PATH="${shPath(dir)}:$PATH" PLAN="${shPath(join(dir, 'plan'))}" exec "${shPath(script)}"`], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert(run.error === undefined, `the shipped probe could not be executed: ${String(run.error)}`);
  assertEq(run.status, 0, `the shipped probe exited ${String(run.status)}: ${run.stderr}`);

  // THE ASSERTION IS THE PROGRAM'S OWN OUTPUT. It saw ready, then not-ready, then ready, and that is what a
  // recovery is; a probe that reported `R` here would be one whose sequence cannot see a death at all.
  const seq = /ready_seq=([RD]*)/.exec(run.stdout)?.[1] ?? '';
  assertEq(seq, 'RDR', `the shipped probe collapsed a ready/dead/ready run into '${seq}' (${run.stdout.trim()})`);
  // ...and it stopped as soon as the sequence was whole, rather than running its full 120 samples.
  const ok = Number(/ready_ok=([0-9]+)/.exec(run.stdout)?.[1] ?? '0');
  const dead = Number(/ready_dead=([0-9]+)/.exec(run.stdout)?.[1] ?? '0');
  assertEq(ok + dead, 5, `the probe took ${ok + dead} samples; it must stop the moment RDR is complete`);
});

console.log(`\nProjection Phase 2 — mount-hardening gates: ${passed} passed, ${failed} failed`
  + (skippedBlocks.length > 0 ? `, ${skippedBlocks.length} block(s) skipped on ${process.platform}` : ''));
for (const what of skippedBlocks) console.log(`  skipped: ${what}`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`  FAILED: ${name}: ${String(error)}`);
  process.exit(1);
}
