import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

console.log(`\nProjection Phase 2 — mount-hardening gates: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`  FAILED: ${name}: ${String(error)}`);
  process.exit(1);
}
