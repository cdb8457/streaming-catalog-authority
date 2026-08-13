import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHASE7_ARMS,
  PHASE7_ARM_TITLES,
  PHASE7_ACTIONABLE_ARMS,
  PHASE7_RULES,
  PHASE7_SERVER_IDS,
  PHASE7_POLL_INTERVAL_MS,
  PHASE7_ARM_DETAIL_GATE_IDS,
  PHASE7_NONCLAIMS,
  RECOVERY_SUSTAIN_OUTLASTS_THE_FAULT_HOLD,
  THE_LAYER_FLOOR_IS_A_FLOOR_THE_PRODUCT_PROMISES,
  THE_OBSERVATION_IS_SINGLE_FLIGHT_AND_CAN_AGE,
  phase7BudgetKeyFor,
  requiredArmGateIds,
  requiredRunGateIds,
  phase7ClosureProblems,
  type Phase7Results,
} from '../src/core/projection/phase7.js';
import {
  PROJECTIOND_MOUNT_HEALTH,
  PROJECTIOND_MOUNT_RECOVERY,
  PROJECTIOND_MOUNT_TARGET,
  PROJECTION_PHASE_1_BUDGETS,
  PROJECTIOND_CONSUMER_ATTACHMENT,
} from '../src/core/projection/runtime-contract.js';
import {
  MEDIA_SERVER_SOAK, transcodeSourceIsWorthTranscoding,
} from '../src/core/projection/media-server-dataplane.js';
import { RELIABILITY_LOOP_RULES } from '../src/core/projection/reliability-loop.js';

// Projection Phase 7 — the operator-usable alpha, offline.
//
// WHAT THIS SUITE IS FOR. The gate itself needs Docker, /dev/fuse, three real media servers, a real
// PostgreSQL and the operator's real-provider corpus. This runs everywhere in seconds and pins the things a
// real run cannot check about itself:
//
//   * every threshold the contract predeclared, against the constant it claims to derive from — so a number
//     cannot be "adjusted" after a run misses it without a test failing;
//   * that the GATE restates none of those numbers, and reads them out of the module instead;
//   * that a skipped arm, a missing stage, a duplicated verdict, a skip, or a budget the run supplied for
//     itself cannot be read as success;
//   * that the three media servers are started BEFORE the daemon mounts, which is §11 of the product
//     contract and the only bind that can follow a remount;
//   * that the mount-layer count is taken above a floor that is MEASURED before the first mount;
//   * and that the gate's port block collides with no other gate in `deploy/`.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push([name, error]);
    console.log(`  FAIL  ${name}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: got ${String(actual)}, want ${String(expected)}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const GATE = 'deploy/projection-phase7-gate.sh';
const THREE = 'deploy/projection-phase7-gate-three.sh';
const OPTIONAL = 'deploy/projection-phase7-gate-optional.sh';
const COMPOSE = 'docker-compose.projection-phase7.yml';
const CONTRACT = 'docs/PROJECTION_PHASE_7_OPERATOR_USABLE_ALPHA.md';
const gate = read(GATE);

console.log('Projection Phase 7 — the operator-usable alpha, offline');

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe predeclared thresholds, against the constants they claim to derive from');
// ---------------------------------------------------------------------------------------------------------

test('one arm per fault: the arm list IS the stage list', () => {
  assertEq(PHASE7_RULES.ARMS_PER_RUN, PHASE7_ARMS.length, 'ARMS_PER_RUN');
  assertEq(PHASE7_ARMS.length, 6, 'six arms');
  assertEq(PHASE7_ARMS.join(' '), 'R1 R2 R3 R4 R5 R6', 'the arm order is part of the contract');
});

test('every arm has a title, a detail set, and no arm is silently untitled', () => {
  for (const arm of PHASE7_ARMS) {
    assert(typeof PHASE7_ARM_TITLES[arm] === 'string' && PHASE7_ARM_TITLES[arm].length > 10,
      `${arm} has no title`);
    assert(PHASE7_ARM_DETAIL_GATE_IDS[arm].length >= 6, `${arm} carries too few measurements to be an arm`);
  }
});

test('the three arms the supervisor is expected to ACT on are named, and the rest are controls', () => {
  assertEq(PHASE7_ACTIONABLE_ARMS.join(' '), 'R1 R2 R6', 'the actionable arms');
  for (const arm of PHASE7_ACTIONABLE_ARMS) {
    assert(PHASE7_ARMS.includes(arm), `${arm} is not one of the arms`);
  }
});

test('every budget Phase 3 already derived is IMPORTED rather than derived a second time', () => {
  // TWO DERIVATIONS OF ONE BUDGET ARE TWO BUDGETS THE MOMENT EITHER IS EDITED, which is why these are
  // identities against Phase 3's module rather than repetitions of Phase 3's arithmetic.
  assertEq(PHASE7_RULES.READY_BUDGET_MS, RELIABILITY_LOOP_RULES.READY_BUDGET_MS, 'READY_BUDGET_MS');
  assertEq(PHASE7_RULES.READ_FAIL_BUDGET_MS, RELIABILITY_LOOP_RULES.READ_FAIL_BUDGET_MS, 'READ_FAIL');
  assertEq(PHASE7_RULES.BREAKER_REFUSAL_BUDGET_MS, RELIABILITY_LOOP_RULES.BREAKER_REFUSAL_BUDGET_MS, 'refusal');
  assertEq(PHASE7_RULES.OUTAGE_RECOVERY_BUDGET_MS, RELIABILITY_LOOP_RULES.OUTAGE_RECOVERY_BUDGET_MS, 'outage');
  assertEq(PHASE7_RULES.HOLD_WINDOW_MS, RELIABILITY_LOOP_RULES.HOLD_WINDOW_MS, 'hold window');
  assertEq(PHASE7_RULES.HOLD_RESOLVER_REQUESTS_MAX, RELIABILITY_LOOP_RULES.HOLD_RESOLVER_REQUESTS_MAX, 'hold');
  assertEq(PHASE7_RULES.HALF_OPEN_PROBES, RELIABILITY_LOOP_RULES.HALF_OPEN_PROBES, 'half-open');
  assertEq(PHASE7_RULES.CONSECUTIVE_FRESH_RUNS, RELIABILITY_LOOP_RULES.CONSECUTIVE_FRESH_RUNS, 'runs');
  assertEq(PHASE7_RULES.OPERATOR_WINDOWS_REQUIRED, RELIABILITY_LOOP_RULES.OPERATOR_WINDOWS_REQUIRED, 'windows');
  assertEq(PHASE7_POLL_INTERVAL_MS, RELIABILITY_LOOP_RULES.READY_BUDGET_MS - PHASE7_RULES.READ_FAIL_BUDGET_MS,
    'the poll interval is the half of READY_BUDGET_MS that is not the read deadline');
});

test('the playback window is PHASE 1s, at Phase 1s own numbers, and is not a new choice', () => {
  // THIS IS WHERE PHASE 7 DIFFERS FROM PHASE 3 AND THE DIFFERENCE IS THE POINT. Phase 3 CHOSE thirty seconds
  // and named both bounds for it; Phase 7's claim is that an operator can USE this, and thirty decoded
  // seconds does not support it. So the window is G8's and G10's own, imported.
  assertEq(PHASE7_RULES.PLAY_DECODED_SECONDS_MIN, MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS, 'direct play');
  assertEq(PHASE7_RULES.TRANSCODE_DECODED_SECONDS_MIN, MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS, 'transcode');
  assertEq(PHASE7_RULES.PLAY_START_BUDGET_MS, MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS * 1_000, 'startup');
  assertEq(PHASE7_RULES.SEEK_COUNT, MEDIA_SERVER_SOAK.SEEK_COUNT, 'seeks');
  assertEq(PHASE7_RULES.PLAY_DECODED_SECONDS_MIN, 300, 'five minutes');
  assert(PHASE7_RULES.PLAY_DECODED_SECONDS_MIN > RELIABILITY_LOOP_RULES.PLAY_DECODED_SECONDS_MIN,
    'Phase 7s window must be strictly longer than Phase 3s, or the tranche has not raised the claim at all');
});

test('the recovery action budget is Phase 6 section 3.3s own arithmetic and nothing else', () => {
  assertEq(PHASE7_RULES.RECOVERY_ACTION_BUDGET_MS,
    PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_SUSTAIN_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_TICK_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_ATTEMPT_DEADLINE_MS,
    'the fault hold, the second hold, one tick and the attempt deadline');
  assertEq(PHASE7_RULES.RECOVERY_READY_BUDGET_MS,
    PHASE7_RULES.RECOVERY_ACTION_BUDGET_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_CONFIRM_MS
    + PHASE7_RULES.READY_BUDGET_MS,
    'the action budget, the confirmation window and the daemon-readiness budget');
  // AND THE ORDER OF EVENTS THE BUDGET DESCRIBES IS ONE THAT STILL HAPPENS.
  assert(RECOVERY_SUSTAIN_OUTLASTS_THE_FAULT_HOLD,
    'the sustain no longer outlasts the fault hold, so the budget describes an order that no longer occurs');
  assert(PHASE7_RULES.RECOVERY_READY_BUDGET_MS > PHASE7_RULES.RECOVERY_ACTION_BUDGET_MS,
    'a recovery cannot be READY before it has ACTED');
});

test('the budget, the cooldown and the lockout window are Phase 6s, imported', () => {
  assertEq(PHASE7_RULES.RECOVERY_MAX_ATTEMPTS, PROJECTIOND_MOUNT_RECOVERY.RECOVERY_MAX_ATTEMPTS, 'attempts');
  assertEq(PHASE7_RULES.RECOVERY_COOLDOWN_MS, PROJECTIOND_MOUNT_RECOVERY.RECOVERY_COOLDOWN_MS, 'cooldown');
  assertEq(PHASE7_RULES.LOCKOUT_QUIET_WINDOW_MS, 2 * PROJECTIOND_MOUNT_RECOVERY.RECOVERY_COOLDOWN_MS,
    'RC9s own rule: two whole cooldowns, because one is satisfied by a supervisor merely between attempts');
  assertEq(PHASE7_RULES.LIBRARY_CHURN_MAX, PROJECTION_PHASE_1_BUDGETS.MAX_LIBRARY_CHURN_ITEMS, 'churn');
});

test('the mount-layer bound is ONE, counted above a floor the product promises never to lower', () => {
  // ONE NAMESPACE BEING SERVED IS ONE LIVE LAYER. Every other layer is a dead one nobody can read through,
  // and Phase 6 §9.7 measured the opposite on the real host and named removing them as next work.
  assertEq(PHASE7_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX, 1, 'one live layer');
  assertEq(PHASE7_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END, PHASE7_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX,
    'a bound that grew with the arm count would be a bound on nothing');
  assert(THE_LAYER_FLOOR_IS_A_FLOOR_THE_PRODUCT_PROMISES,
    'the product no longer promises to leave the anchor mount alone, so counting above it counts nothing');
  assertEq(PROJECTIOND_MOUNT_TARGET.ANCHOR_IS_NEVER_DETACHED_TO_MAKE_ROOM, true, 'the anchor rule');
});

test('the wedged-probe rough edge is still true of the product, so the document still owes it', () => {
  // PHASE 7 DOES NOT FIX PHASE 6 §9.2 AND SAYS SO. This is the fact that keeps the admission honest: if the
  // sampler ever stopped being single-flight, the paragraph in §8.2 would be describing something else.
  assert(THE_OBSERVATION_IS_SINGLE_FLIGHT_AND_CAN_AGE,
    'the mount observation is no longer single-flight, so §8.2 of the contract describes a product that has changed');
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe gate restates no threshold, and reads every one of them out of the module');
// ---------------------------------------------------------------------------------------------------------

test('no budget is spelled as a literal anywhere in the gate', () => {
  // A BUDGET RESTATED IN A SHELL SCRIPT IS A BUDGET THAT DRIFTS THE MOMENT EITHER COPY MOVES, and this
  // repository has already retired two thresholds for exactly that.
  const interesting = new Set<number>();
  for (const value of Object.values(PHASE7_RULES)) {
    if (typeof value === 'number' && value >= 1000) interesting.add(value);
  }
  const offenders: string[] = [];
  for (const value of interesting) {
    // The number as a bare token: not part of a longer number, a port, a digest or a path.
    const pattern = new RegExp(`(^|[^0-9A-Za-z_/.-])${value}([^0-9A-Za-z_/.-]|$)`);
    for (const line of gate.split('\n')) {
      if (line.trimStart().startsWith('#')) continue;
      if (pattern.test(line)) offenders.push(`${value} in: ${line.trim().slice(0, 90)}`);
    }
  }
  assertEq(offenders.length, 0, `the gate spells a predeclared budget as a literal:\n    ${offenders.join('\n    ')}`);
});

test('the gate evaluates the budgets out of the CLI exactly once, and dies if it cannot', () => {
  assert(gate.includes('projection-phase7-cli.ts budgets --sh'),
    'the gate does not read its budgets from the module');
  assert(/P7_BUDGETS=.*budgets --sh.*\n\s*\|\| die/.test(gate),
    'a gate that cannot read its budgets must die rather than proceed against nothing');
  assert(gate.includes('eval "$P7_BUDGETS"'), 'the budgets are never evaluated');
});

test('every threshold the module publishes is actually USED by the gate, or it is decoration', () => {
  const unused: string[] = [];
  for (const key of Object.keys(PHASE7_RULES)) {
    if (key === 'CONSECUTIVE_FRESH_RUNS') continue; // the three-runner's, not the gate's
    if (key === 'MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END' && gate.includes('P7_MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END')) continue;
    if (!gate.includes(`P7_${key}`)) unused.push(key);
  }
  assertEq(unused.length, 0, `the contract publishes thresholds the gate never uses: ${unused.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe gate does the things a real run cannot check about itself');
// ---------------------------------------------------------------------------------------------------------

test('the three media servers are started BEFORE the daemon mounts, and that order is the whole of §11', () => {
  // A CONSUMER THAT BINDS THE PROJECTED PATH AFTER THE DAEMON HAS MOUNTED THERE CANNOT FOLLOW A REMOUNT, and
  // no daemon behaviour can make it. This is the shipped product rule, not this gate's habit.
  assertEq(PROJECTIOND_CONSUMER_ATTACHMENT.BIND_BEFORE_FIRST_MOUNT, true, 'the product rule');
  const startJf = gate.indexOf('\nstart_jellyfin\n');
  const startEmby = gate.indexOf('\nstart_emby\n');
  const startPlex = gate.indexOf('\nstart_plex\n');
  const startDaemon = gate.indexOf('\nstart_daemon\n');
  assert(startJf > 0 && startEmby > 0 && startPlex > 0 && startDaemon > 0, 'a start call is missing');
  assert(startJf < startDaemon && startEmby < startDaemon && startPlex < startDaemon,
    'a media server is started AFTER the daemon mounts, which is the one order that cannot survive a remount');
});

test('the daemon runs with BOTH supervisors, which is what the shipped alpha profile does', () => {
  assert(/--auto-remount --auto-recover/.test(gate),
    'the subject daemon does not run the two supervisors the alpha profile ships');
  const profile = read('docker-compose.projection-alpha.yml');
  assert(profile.includes('--auto-remount') && profile.includes('--auto-recover'),
    'the shipped profile no longer passes both flags, so the gate is measuring a different daemon');
});

test('the mount-layer floor is MEASURED before the first mount, not assumed', () => {
  const floorAt = gate.indexOf('MOUNT_LAYER_FLOOR="$(count_our_layers)"');
  const startDaemon = gate.indexOf('\nstart_daemon\n');
  assert(floorAt > 0, 'the layer floor is never measured');
  assert(floorAt < startDaemon, 'the layer floor is taken AFTER the daemon has mounted, which measures itself');
  assert(gate.includes('layers_above_floor'), 'nothing ever counts above the floor');
});

test('the consumers own binds are fingerprinted before the first mount and compared after every arm', () => {
  const before = gate.indexOf('bind_fingerprint "$WORK/out/binds-before.txt"');
  const startDaemon = gate.indexOf('\nstart_daemon\n');
  assert(before > 0 && before < startDaemon,
    'the bind fingerprint is taken after the daemon mounts, so it cannot say what was there before');
  assert(gate.includes('P7-arm-binds-unchanged'), 'no arm ever compares the binds');
});

test('the gate has no optional arm: a missing nsenter FAILS rather than skipping', () => {
  assert(gate.includes('P7_HAS_NSENTER'), 'the injector capability is never probed');
  assert(!/skip "R6/.test(gate), 'R6 can skip, and a skip is a failure in this gate');
  assert(/P7_HAS_NSENTER" -eq 0 \]; then\s*\n\s*die /.test(gate),
    'a host without nsenter must fail the arm with a reason rather than skip it');
});

test('the status reader can read a 503, which is the answer every fault in this gate produces', () => {
  // THE INSTRUMENT THAT COULD NOT SEE THE ANSWER. Phase 3 DEFINED `daemon_status` and never called it, so
  // its first real use was Phase 7's arm R1 — and it was `wget -q -O -`, which exits non-zero and writes
  // NOTHING for any status outside 2xx. Readiness answers 503 for every fault this tranche injects, so the
  // arm recorded `reason='none' observation='none'` about a daemon that was `Up (unhealthy)` throughout.
  assert(!/wget .*-O - "http:\/\/127\.0\.0\.1:\$\{DAEMON_STATUS_PORT\}\/readyz"/.test(gate),
    'the status reader is a wget that discards every non-2xx body, so it cannot read a 503');
  assert(/DAEMON_STATUS_CODE="\$\(printf/.test(gate), 'the reader does not capture the status code');
  assert(/200\|503\)/.test(gate), 'the reader does not accept a 503 as a reading');
  assert(gate.includes('cat > "$WORK/out/http.sh"'), 'the raw HTTP reader is not embedded');
  // ...AND AN UNREACHABLE DAEMON IS STILL AN ABSENT READING, which is the OTHER meaning and must stay
  // distinguishable from a 503 carrying a complete document.
  assert(/\*\) : > "\$1"; return 1 ;;/.test(gate),
    'an unreachable daemon no longer leaves the caller with nothing, so absence and refusal have collapsed');
});

test('the three-runner counts, refuses to announce a sequence it did not complete, and propagates 77', () => {
  const three = read(THREE);
  assert(three.includes('completed=$((completed + 1))'), 'runs are not counted');
  assert(three.includes('refusing to report a completed sequence'), 'a zero-run loop could announce success');
  assert(three.includes('exit "$GATE_SKIP_STATUS"'), 'a skip is folded into something other than a skip');
  assert(three.includes('projection-phase7-gate.sh'), 'the runner does not run this gate');
});

test('the optional wrapper says NOTHING WAS PROVED and is not the closing command', () => {
  const optional = read(OPTIONAL);
  assert(/NOTHING WAS PROVED|closes nothing|not a pass/i.test(optional),
    'the optional wrapper does not say that a skip proves nothing');
});

test('the gate port collides with no other gate in deploy/, and the compose file is its own project', () => {
  const compose = read(COMPOSE);
  const portMatch = /:-(\d{4})\}:5432/.exec(compose);
  assert(portMatch !== null, 'the compose file publishes no recognisable PostgreSQL port');
  const port = portMatch[1] as string;
  assertEq(port, '5620', 'the Phase 7 port');
  assert(compose.includes('name: projection-phase7-gate'), 'the compose project is not its own');
  const others: string[] = [];
  for (const entry of readdirSync(repoRoot)) {
    if (!entry.startsWith('docker-compose.') || entry === COMPOSE.replace(/^.*\//, '')) continue;
    const text = readFileSync(join(repoRoot, entry), 'utf8');
    if (new RegExp(`[":-]${port}(["}:]|$)`, 'm').test(text)) others.push(entry);
  }
  assertEq(others.length, 0, `port ${port} is also claimed by ${others.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe closure check, driven rather than read');
// ---------------------------------------------------------------------------------------------------------

const passing = (gateId: string, measured?: number, budget?: number): Record<string, unknown> => ({
  gate: gateId, verdict: 'pass', ...(measured === undefined ? {} : { measured, budget }),
});

function completeRun(): Phase7Results {
  const results: Array<Record<string, unknown>> = [];
  const add = (id: string): void => {
    const key = phase7BudgetKeyFor(id);
    if (key === undefined) { results.push(passing(id)); return; }
    results.push(passing(id, PHASE7_RULES[key] as number, PHASE7_RULES[key] as number));
  };
  for (const arm of PHASE7_ARMS) for (const id of requiredArmGateIds(arm)) add(id);
  for (const id of requiredRunGateIds()) add(id);
  return {
    arms: PHASE7_ARMS.map((arm, index) => ({ index: index + 1, arm })),
    results: results as never,
  };
}

test('a complete run has no problems, which is what makes every failure below meaningful', () => {
  const problems = phase7ClosureProblems(completeRun());
  assertEq(problems.length, 0, `a complete run reported problems: ${problems.slice(0, 6).join(' | ')}`);
});

test('a MISSING measurement is a failure, and never a shorter run that passed', () => {
  const document = completeRun();
  const trimmed = { ...document, results: document.results.filter((r) => r.gate !== 'P7-R1-ready-ms') };
  const problems = phase7ClosureProblems(trimmed);
  assert(problems.some((p) => p.includes('P7-R1-ready-ms') && p.includes('absent')),
    'an absent measurement was not reported as one');
});

test('a SKIP is a failure: this gate has no optional arms', () => {
  const document = completeRun();
  const results = document.results.map((r) => (r.gate === 'P7-R5-overlay-still-mounted'
    ? { ...r, verdict: 'skip' as const } : r));
  const problems = phase7ClosureProblems({ ...document, results });
  assert(problems.some((p) => p.includes('P7-R5-overlay-still-mounted')), 'a skipped verdict passed');
});

test('a budget the RUN supplied for itself is refused, even beside a correct measurement', () => {
  const document = completeRun();
  const results = document.results.map((r) => (r.gate === 'P7-R6-attempts-spent'
    ? { ...r, measured: 99, budget: 99 } : r));
  const problems = phase7ClosureProblems({ ...document, results });
  assert(problems.some((p) => p.includes('P7-R6-attempts-spent') && p.includes('where the contract names')),
    'a verdict measured against a budget nobody agreed to was accepted');
});

test('two verdicts under one id are refused rather than the later one winning', () => {
  const document = completeRun();
  const results = [...document.results, passing('P7-R1-ready-ms', 1, PHASE7_RULES.RECOVERY_READY_BUDGET_MS)];
  const problems = phase7ClosureProblems({ ...document, results: results as never });
  assert(problems.some((p) => p.includes('two verdicts')), 'one id answered one question twice');
});

test('an arm run out of order, or a missing arm, fails on the SET rather than on a count', () => {
  const document = completeRun();
  const shuffled = { ...document, arms: [...document.arms].reverse().map((a, i) => ({ ...a, index: i + 1 })) };
  const problems = phase7ClosureProblems(shuffled);
  assert(problems.some((p) => p.includes('where the contract names')), 'the arm order was not checked');
  const short = { ...document, arms: document.arms.slice(0, 5) };
  const shortProblems = phase7ClosureProblems(short);
  assert(shortProblems.some((p) => p.includes('R6') && p.includes('never run')), 'a missing arm passed');
});

test('a recorded failure OUTSIDE the required set is still a failure', () => {
  const document = completeRun();
  const results = [...document.results, { gate: 'P7-something-else', verdict: 'fail' as const }];
  const problems = phase7ClosureProblems({ ...document, results: results as never });
  assert(problems.some((p) => p.includes('P7-something-else')), 'a failure outside the required set was ignored');
});

test('every required id the module names is an id the GATE actually records', () => {
  // THE OTHER DIRECTION, AND IT IS THE ONE THAT CATCHES A CONTRACT NOBODY IMPLEMENTED. A closure rule that
  // requires an id no gate writes is a rule that fails every run for a reason that is about the document.
  const missing: string[] = [];
  // THE STEM IS WHAT THE GATE SPELLS: the arm and the server are appended by the caller, so an id like
  // `P7-arm-inread:plex:R4` is written in the gate as the two parts `P7-arm-inread` and `:$server:$arm`.
  const stemOf = (id: string): string =>
    id.replace(/:R[0-9]$/, '').replace(/:(emby|jellyfin|plex)$/, '');
  const ids = [
    ...PHASE7_ARMS.flatMap((arm) => requiredArmGateIds(arm)),
    ...requiredRunGateIds(),
  ];
  for (const id of ids) {
    if (!gate.includes(stemOf(id))) missing.push(id);
  }
  assertEq(missing.length, 0, `the closure rule requires ids the gate never records: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------------------
test('every program the gate embeds actually PARSES, extracted and checked rather than grepped', () => {
  // PHASE 1 SPENT FOUR DISPATCHES ON PROGRAMS WRITTEN INTO GATES AND CHECKED ONLY BY REGEX, and every
  // dispatch found defects a regex cannot see. This is the same lesson met from a new direction: the Phase 7
  // gate is GENERATED, and a generator that rendered a backslash-n into a real newline inside a quoted
  // JavaScript string produced a file that would not parse. The first real run found it at arm 1 of 6, after
  // two hours of playback had already been measured and thrown away.
  const pattern = /cat > "\$WORK\/out\/([a-z-]+)\.cjs" <<'([A-Z]+)'\n([\s\S]*?)\n\2\n/g;
  const programs = [...gate.matchAll(pattern)];
  assert(programs.length >= 5, `the gate embeds ${programs.length} JavaScript programs; that is too few to `
    + 'be the set this test was written for, so something has moved and the check is not looking at it');
  const dir = mkdtempSync(join(tmpdir(), 'p7-programs-'));
  try {
    for (const match of programs) {
      const name = match[1] as string;
      const source = match[3] as string;
      const path = join(dir, `${name}.cjs`);
      writeFileSync(path, source, 'utf8');
      const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      assertEq(checked.status, 0,
        `${name}.cjs does not parse: ${(checked.stderr || '').split('\n')[1] ?? ''}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe transcode source-codec decision, which the first real run found wrong in three drivers');
// ---------------------------------------------------------------------------------------------------------

test('a source that is not already the TARGET codec is worth transcoding, whatever else it is', () => {
  // THE FIRST REAL PHASE 7 RUN IS WHAT FOUND THIS, AND THE PRODUCT HAD DONE EVERYTHING RIGHT. The operator's
  // object is hevc; all three servers transcoded it to h264 for five minutes — 108 distinct segments each,
  // every one decoded, 324 decoded media seconds against a 300-second floor — and then the source-codec row
  // failed, because `hevc` is not `mpeg4`. Three shipped drivers wrote the sentence "a transcode to h264
  // from a source that was already h264 would prove nothing about an encoder" and then compared against the
  // codec THIS REPOSITORY'S OWN SYNTHETIC FIXTURE uses, which is a different and stricter question.
  assert(transcodeSourceIsWorthTranscoding('hevc'), 'an hevc source is not accepted, which is the defect');
  assert(transcodeSourceIsWorthTranscoding('mpeg4'),
    'Phase 1s own corpus must still pass, or a closed result has been retired by this fix');
  assert(transcodeSourceIsWorthTranscoding('vp9'), 'any non-target codec is worth transcoding away from');
  assert(!transcodeSourceIsWorthTranscoding('h264'),
    'a transcode from the target codec to the target codec proves nothing about an encoder');
  assert(!transcodeSourceIsWorthTranscoding('H264'), 'the comparison must not be fooled by case');
  // AN ABSENT CODEC IS A FAILURE AND NEVER A PASS. A server that said nothing about what it was transcoding
  // FROM leaves the assertion unanchored, and an unanchored assertion is one that cannot fail.
  assert(!transcodeSourceIsWorthTranscoding(''), 'an empty source codec was accepted');
  assert(!transcodeSourceIsWorthTranscoding(undefined), 'an absent source codec was accepted');
  assert(!transcodeSourceIsWorthTranscoding('   '), 'a blank source codec was accepted');
});

test('all three shipped drivers ask the shared question rather than each comparing to the fixture', () => {
  for (const driver of [
    'src/ops/projection-emby-dataplane-cli.ts',
    'src/ops/projection-jellyfin-dataplane-cli.ts',
    'src/ops/projection-plex-dataplane-cli.ts',
  ]) {
    const source = read(driver);
    assert(!source.includes("=== TRANSCODE_SOURCE_VIDEO_CODEC ? 'pass'"),
      `${driver} still decides a source codec by comparing against the synthetic fixture's own codec`);
    assert(source.includes('transcodeSourceIsWorthTranscoding('), `${driver} does not use the shared decision`);
  }
});

// ---------------------------------------------------------------------------------------------------------
console.log('\nthe contract document says what the module says');
// ---------------------------------------------------------------------------------------------------------

test('the contract exists, predeclares a NO-GO list, and does not yet claim a GO', () => {
  const document = read(CONTRACT);
  assert(document.includes('What makes this tranche a NO-GO'), 'the NO-GO conditions are not predeclared');
  assert(/Status: OPEN|Status: CLOSED|Status: NO-GO/.test(document), 'the document carries no status');
  assert(document.includes('MOUNT_LAYERS_ABOVE_FLOOR_MAX'), 'the new threshold is not in the document');
  for (const arm of PHASE7_ARMS) {
    assert(document.includes(`**${arm}**`), `the contract does not name arm ${arm}`);
  }
});

test('every nonclaim is a sentence and the list refuses the three things it must refuse', () => {
  assert(PHASE7_NONCLAIMS.length >= 8, 'the nonclaim list is too short to be the honest one');
  const joined = PHASE7_NONCLAIMS.join(' ').toLowerCase();
  assert(joined.includes('attribution'), 'per-server provider attribution is not refused');
  assert(joined.includes('load test'), 'the load-test nonclaim is missing');
  assert(joined.includes('encoder'), 'the encoder-work limitation Phase 1 measured is not carried forward');
});

test('the server ids are the repositorys own three, in the repositorys own order', () => {
  assertEq(PHASE7_SERVER_IDS.join(' '), 'emby jellyfin plex', 'the server ids');
});

// ---------------------------------------------------------------------------------------------------------
// PROJECTION PHASE 7 §8.4 — THE EXPECTED UNDERLAY, PINNED OFFLINE
//
// WHAT THESE ADD THAT THE GO TESTS DO NOT. The Go tables drive the shipped DECISION: which verdict admits, what
// every topology fingerprints to, and that an unreadable mount table authorises nothing. What they cannot say
// is whether the CONTRACT still says the same thing, whether the GATE asserts it, and whether the safety
// clauses that make the decision narrow are still in the shipped source at all. That is this block.
// ---------------------------------------------------------------------------------------------------------

const UNDERLAY_GO = 'projectiond/internal/fusefs/underlay_linux.go';
const UNDERLAY_GO_TEST = 'projectiond/internal/fusefs/underlay_linux_test.go';
const RECOVERY_GO_SRC = 'projectiond/internal/daemon/recovery.go';
const RECOVERY_GO_TEST = 'projectiond/internal/daemon/recovery_test.go';
const MAIN_GO_SRC = 'projectiond/cmd/projectiond/main.go';
const REMOUNT_GO_TEST = 'projectiond/cmd/projectiond/remount_linux_test.go';

test('the contract predeclares the classification decision, its four verdicts and its safety clauses', () => {
  const document = read(CONTRACT);
  const section = document.slice(document.indexOf('## 8.4 THE CLASSIFICATION DECISION'),
    document.indexOf('## 9. The regression matrix'));
  assert(section.length > 2_000, '§8.4 is missing or is too short to be a contract');
  assert(section.includes('BEFORE THE FIRST RERUN THAT MEASURES IT'),
    '§8.4 does not say that it was written before the run that measures it, which is the whole discipline');
  for (const verdict of PROJECTIOND_MOUNT_RECOVERY.UNDERLAY_VERDICTS) {
    assert(section.includes(`\`${verdict}\``), `§8.4 does not name the verdict ${verdict}`);
  }
  // EXACTLY ONE VERDICT MAY BE DESCRIBED AS ADMITTING ANYTHING, and the document has to say which.
  assert(/\*\*THE ONLY ADMITTING VALUE\.\*\*/.test(section),
    '§8.4 does not name exactly one admitting verdict');
  assert(section.includes('recover-mount-underlay'), '§8.4 does not name the code the decision publishes');
  // The clauses that make it narrow, each of which a later reader could quietly drop.
  for (const clause of [
    'IS NOT TRUSTED AND NEITHER IS ANY OTHER TYPE',
    'EXACTLY ONE ROW OF THE CLASSIFICATION TABLE',
    'R5 IS UNTOUCHED',
    'NOTHING IS EVER UNMOUNTED ON THIS PATH',
    'RE-TAKEN AT THE MOMENT THE BUDGET IS SPENT',
    'CANNOT BLOCK',
    'AN UNWIRED VERIFIER REFUSES',
  ]) {
    assert(section.includes(clause), `§8.4's safety contract no longer carries the clause "${clause}"`);
  }
});

test('the reinstated R1 clause is reinstated WORD FOR WORD, and the history of it being false is kept', () => {
  const document = read(CONTRACT);
  // The superseded quotation is still there, still inside a blockquote, still marked as history.
  assert(/> \*\*HISTORICALLY — SUPERSEDED\.\*\* §3\.1's R1 row/.test(document),
    'the record no longer keeps the R1 clause it once measured FALSE');
  // ...AND THE CLAUSE ITSELF IS STILL IN §3.1, UNEDITED. A reinstatement that quietly softened the clause
  // would be the threshold move this document forbids, wearing a correction's clothes.
  const arms = document.slice(document.indexOf('### 3.1 The six arms'), document.indexOf('### 3.2'));
  assert(arms.includes('classifies it as **its own to repair**'),
    "§3.1's R1 row no longer asks the daemon to classify the fault as its own to repair");
  assert(arms.includes('spends **exactly one** attempt inside `RECOVERY_ACTION_BUDGET_MS`'),
    "§3.1's R1 row no longer asks for exactly one attempt inside the action budget");
  assert(document.includes('REINSTATED, WORD FOR WORD'),
    '§8.4.4 no longer states that the clause is reinstated rather than rewritten');
});

test('the gate reads the two new surface fields and asserts them on BOTH sides of the decision', () => {
  // R1 IS THE ADMITTING SIDE AND R5 IS THE REFUSING ONE. A gate that only ever saw the admitting verdict
  // would not be able to tell a working distinction from a daemon that had started trusting everything.
  assert(gate.includes('recoveryUnderlay'), 'the gate does not read the underlay verdict at all');
  assert(gate.includes('recoveryUnderlayDigest'), 'the gate does not read the underlay fingerprint at all');
  for (const id of ['P7-R1-underlay-covered-before', 'P7-R1-underlay-fingerprinted',
    'P7-R1-action-is-the-underlay-row', 'P7-R1-underlay-digest-unchanged', 'P7-R5-underlay-refuses']) {
    assert(gate.includes(`"${id}"`), `the gate no longer records ${id}`);
  }
  // AND THE REFUSING SIDE ASSERTS THE REFUSING VERDICT BY NAME. `underlay-exposed` there would be the
  // --auto-remount defect reopened, and this is the assertion that would catch it on a real host.
  const r5 = gate.slice(gate.indexOf('arm_R5()'), gate.indexOf('arm_R6()'));
  // AND IT COMPARES AGAINST THE REFUSING VERDICT IN THE ASSERTION ITSELF, not merely somewhere in the arm.
  // The arm now also EXPLAINS in prose why `underlay-exposed` there would be the `--auto-remount` defect
  // reopened, so a search of the whole arm for that word would find the explanation and prove nothing.
  assert(/REC_UNDERLAY:-\}" = "underlay-covered"/.test(r5),
    'R5 does not COMPARE the published verdict against the refusing one, so a widened decision would pass it');
});

test('R6 injects R1s fault, which is what §3.1 predeclared for it before the first measured run', () => {
  const r6 = gate.slice(gate.indexOf('arm_R6()'));
  const body = r6.slice(0, r6.indexOf('\n# ---'));
  assert(body.includes('umount -l "$WORK/mnt"'),
    'R6 no longer removes the subject\'s own mount, so its fault is one the drain can repair without a mount '
    + 'syscall — which is exactly the state §11.4.1 measured RC8 failing on');
  assert(!body.includes('start_blocker'),
    'R6 still stacks a second daemon\'s corpse, which the corpse drain now repairs without any mount '
    + 'succeeding, so the arm asserts a state its own injector cannot produce');
  assert(body.includes('/dev/null /dev/fuse'), 'R6 no longer masks /dev/fuse, so a mount could succeed');
  assert(body.includes('P7-R6-fault-took-the-mount'), 'R6 does not assert that its fault landed');
  assert(body.includes('the daemon exited on the fault'),
    'R6 does not fail loudly when the serve loop dies, so it could report a budget nobody spent');
});

test('Phase 6s RC8 injector is repaired the same way, and its assertions are untouched', () => {
  const recoveryGate = read('deploy/projection-recovery-gate.sh');
  const rc8 = recoveryGate.slice(recoveryGate.indexOf('step "RC8, RC9 and RC11'));
  assert(rc8.includes('umount -l "$WORK/mnt"'), 'RC8 no longer removes the subject\'s own mount');
  assert(rc8.includes('rc8-holder.pid'),
    'RC8 does not hold a descriptor inside the mount, so the lazy detach would abort the connection and the '
    + 'serve supervisor would own the fault instead of the recovery loop');
  assert(rc8.includes('the daemon exited on the fault'),
    'RC8 does not fail loudly when the serve loop dies');
  // THE ASSERTIONS. Every one of these is Phase 6's own and none of them may be weakened by the repair.
  assert(rc8.includes('$RC8_MIN_GAP" -ge "$RC_RECOVERY_COOLDOWN_MS'),
    'RC8 no longer compares the closest pair of attempt starts against the whole cooldown');
  assert(rc8.includes('RC8_ATTEMPTS" = "$RC_RECOVERY_MAX_ATTEMPTS'),
    'RC8 no longer requires exactly the whole budget to be spent');
  assert(rc8.includes('RC8_CORROBORATED'), 'RC8 no longer corroborates the ledger against Docker\'s own clock');
  assert(rc8.includes('$RC9_REMEDIATION" = "$RC_REMEDIATION_RESET_RECOVERY_LEDGER'),
    'RC9 no longer requires the lockout to name the reset as its remediation');
  assert(rc8.includes('RC11_AFTER_RESET'), 'RC11 no longer measures the state after the operator reset');
});

test('the underlay decision is shipped, table-driven, and its refusing branches are EXECUTED', () => {
  const source = read(UNDERLAY_GO);
  const table = read(UNDERLAY_GO_TEST);
  // The seam that makes the unreadable-mount-table branch reachable from a test at all.
  assert(source.includes('func mountStackAtFrom(path, mountInfoPath string)'),
    'the mount-table read has no seam, so the fail-closed branch cannot be executed by any test');
  assert(table.includes('mountStackAtFrom('), 'the Go table does not drive the seam');
  // Every topology this tranche's arms produce has a row, by the name the case is given.
  for (const topology of [
    'the projectiond mount is gone and the operator\'s own bind is exposed',
    'our own live mount is on top of it, which is the healthy steady state',
    'a tmpfs is stacked above the live mount',
    'a second daemon\'s corpse is above our live mount',
    'our own corpse is the only thing above the bind',
    'the operator detached and reattached their own share',
    'the bind\'s propagation relationship changed',
    'the same two rows in the other order',
  ]) {
    assert(table.includes(topology), `the Go table has no row for: ${topology}`);
  }
  assert(table.includes('TestAnUnreadableMountTableAuthorisesNothing'),
    'the unreadable-mount-table branch has no test, so the one branch nothing has run is the safety one');
  // AND THE FINGERPRINT COVERS THE FIELDS THE CONTRACT NAMES. A field dropped from the identity is a
  // distinction silently stopped being made.
  for (const field of ['MountID', 'ParentID', 'Device', 'Root', 'MountPoint', 'Propagation', 'FsType',
    'Source']) {
    assert(new RegExp(`${field}\\s`).test(source), `the mount identity no longer carries ${field}`);
  }
});

test('the licence to act is contained: one row, one verdict, and a table that proves it', () => {
  const recovery = read(RECOVERY_GO_SRC);
  const table = read(RECOVERY_GO_TEST);
  assert(recovery.includes('func classifyRecovery(readyReason, observed, underlay string)'),
    'classifyRecovery no longer takes the underlay verdict');
  const classify = recovery.slice(recovery.indexOf('func classifyRecovery'),
    recovery.indexOf('func decideRecovery'));
  assertEq((classify.match(/\bunderlay ==/g) ?? []).length, 1,
    'the underlay verdict is compared in more than one place in the classification');
  assertEq((classify.match(/\bunderlay !=/g) ?? []).length, 0,
    'the underlay verdict is compared with an inequality, which admits every value but one rather than one');
  assert(table.includes('TestTheUnderlayVerdictIsReadOnlyOnTheForeignRow'),
    'nothing drives every readiness reason and every observation against every verdict, so "we only read it '
    + 'in one place" is an argument about the code rather than a measurement of it');
  assert(table.includes('TestAnUnwiredUnderlayVerifierRefuses'),
    'the unwired-verifier branch has no test');
  assert(table.includes('TestAVerdictOutsideTheClosedSetIsNotAVerdict'),
    'the guard against a verdict from outside the closed set has no test');
});

test('the layer residual fix is a named decision with a table, not five conditions inside an if', () => {
  const main = read(MAIN_GO_SRC);
  const table = read(REMOUNT_GO_TEST);
  assert(main.includes('func drainAloneRepairedIt('),
    'the drain-alone repair is not a named function, so no table can drive the shipped decision');
  assert(table.includes('TestTheDrainAloneRepairIsRefusedUnlessAllFiveConditionsHold'),
    'the drain-alone repair has no table');
  assert(table.includes('TestTheDrainAloneRepairIsOnlyReachedAfterADrain'),
    'nothing pins WHERE the drain-alone repair is called from, which no pure function can say about itself');
  // AND THE THRESHOLD IT IS MEASURED AGAINST DID NOT MOVE.
  assertEq(THE_LAYER_FLOOR_IS_A_FLOOR_THE_PRODUCT_PROMISES, true,
    'the product no longer promises never to detach the anchor, so counting layers above it counts nothing');
  const document = read(CONTRACT);
  assert(document.includes('The threshold is unchanged and it is still expected'),
    '§8.5 no longer states that the predeclared layer threshold did not move');
});

// ---------------------------------------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  for (const [name, error] of failures) {
    console.error(`\n  ${name}\n    ${(error as Error).message}`);
  }
  process.exit(1);
}
