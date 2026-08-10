import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logicalLines, parseShellSource } from './helpers/shell-source.js';
import {
  RELIABILITY_LOOP_ARMS,
  RELIABILITY_LOOP_RULES,
  RELIABILITY_SERVER_IDS,
  RELIABILITY_POLL_INTERVAL_MS,
  ROTATION_REFUSAL_BELOW_BREAKER,
  ARM_DETAIL_GATE_IDS,
  REQUIRED_RUN_GATE_IDS,
  budgetKeyFor,
  requiredCycleGateIds,
  reliabilityClosureProblems,
} from '../src/core/projection/reliability-loop.js';
import {
  PROJECTIOND_READ_POLICY,
  PROJECTIOND_ADMISSION_LIMITS,
  PROJECTIOND_CIRCUIT_BREAKER,
  PROJECTIOND_ACCESS_RESOLUTION,
  PROJECTION_PHASE_1_BUDGETS,
  PROJECTIOND_CONSUMER_ATTACHMENT,
} from '../src/core/projection/runtime-contract.js';

// Projection Phase 3 — the reliability loop, offline.
//
// WHAT THIS SUITE IS FOR. The gate itself needs Docker, /dev/fuse, three real media servers, a real
// PostgreSQL and the operator's real-provider corpus. This runs everywhere in seconds and pins the things a
// real run cannot check about itself:
//
//   * every threshold the contract predeclared, against the constant it claims to derive from — so a number
//     cannot be "adjusted" after a run misses it without a test failing;
//   * that the GATE restates none of those numbers, and reads them out of the module instead;
//   * that a skipped arm, a missing phase, a duplicated verdict or a budget the run supplied for itself
//     cannot be read as success;
//   * that `--no-barrier` is contained to this gate and cannot reach a Phase 1 caller;
//   * that the port block collides with no other gate in `deploy/`;
//   * and that the embedded programs are EXECUTED rather than grepped, because Phase 1 spent four dispatches
//     on programs that were only ever matched by regex and every dispatch found defects a regex cannot see.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
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

const GATE = 'deploy/projection-reliability-loop-gate.sh';
const THREE = 'deploy/projection-reliability-loop-gate-three.sh';
const OPTIONAL = 'deploy/projection-reliability-loop-gate-optional.sh';
const DOC = 'docs/PROJECTION_PHASE_3_RELIABILITY_LOOP.md';

console.log('Projection Phase 3 — the reliability loop (offline)');

// ---------------------------------------------------------------------------------------------------------
// The ship set
// ---------------------------------------------------------------------------------------------------------

test('the gate, both wrappers, the compose file, the module, the CLI and the contract all exist', () => {
  for (const path of [GATE, THREE, OPTIONAL, DOC,
    'docker-compose.projection-reliability.yml',
    'src/core/projection/reliability-loop.ts',
    'src/ops/projection-reliability-loop-cli.ts']) {
    assert(existsSync(join(repoRoot, path)), `${path} is missing`);
  }
});

test('the npm scripts are wired to the scripts that exist', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['go:reliability-loop-gate'], `bash ${GATE}`, 'the single-run script');
  assertEq(pkg.scripts['go:reliability-loop-gate:three'], `bash ${THREE}`, 'the three-run script');
  assertEq(pkg.scripts['go:reliability-loop-gate:optional'], `bash ${OPTIONAL}`, 'the optional script');
  assertEq(pkg.scripts['test:projection-reliability-loop'], 'tsx test/projection-reliability-loop.ts',
    'this suite');
});

// ---------------------------------------------------------------------------------------------------------
// The thresholds, against what they claim to derive from
// ---------------------------------------------------------------------------------------------------------

test('every predeclared threshold equals the derivation the contract states for it', () => {
  assertEq(RELIABILITY_LOOP_RULES.CYCLES_PER_RUN, RELIABILITY_LOOP_ARMS.length,
    'one cycle per arm: the arm list IS the cycle list');
  assertEq(RELIABILITY_LOOP_RULES.CONSECUTIVE_FRESH_RUNS, 3, 'the closure convention');
  assertEq(RELIABILITY_LOOP_RULES.READY_BUDGET_MS,
    RELIABILITY_POLL_INTERVAL_MS + PROJECTIOND_READ_POLICY.READ_DEADLINE_MS,
    'the pointer poll plus one read deadline');
  assertEq(RELIABILITY_LOOP_RULES.READ_FAIL_BUDGET_MS, PROJECTIOND_READ_POLICY.READ_DEADLINE_MS,
    'the product\'s own read deadline');
  assertEq(RELIABILITY_LOOP_RULES.BREAKER_REFUSAL_BUDGET_MS, PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS,
    'a locally refused read must beat the shortest wait an admitted read could incur');
  assertEq(RELIABILITY_LOOP_RULES.OUTAGE_RECOVERY_BUDGET_MS,
    PROJECTIOND_CIRCUIT_BREAKER.OPEN_COOLDOWN_MS + PROJECTIOND_READ_POLICY.READ_DEADLINE_MS,
    'the cooldown plus one read deadline');
  assertEq(RELIABILITY_LOOP_RULES.HALF_OPEN_PROBES, PROJECTIOND_CIRCUIT_BREAKER.HALF_OPEN_PROBES,
    'half-open lets exactly one request through');
  assertEq(RELIABILITY_LOOP_RULES.LIBRARY_CHURN_MAX, PROJECTION_PHASE_1_BUDGETS.MAX_LIBRARY_CHURN_ITEMS,
    'the Phase 1 churn budget');
  assertEq(RELIABILITY_LOOP_RULES.HOLD_RESOLVER_REQUESTS_MAX, 0,
    'zero provider traffic while the breaker is open');
});

test('the outage arm\'s hold window ends strictly inside the breaker cooldown', () => {
  // A HOLD THAT COULD OUTLAST THE COOLDOWN WOULD COUNT THE HALF-OPEN PROBE — one legitimate request against
  // a ceiling of zero — and fail a correct product for doing exactly what the contract says it must.
  assert(RELIABILITY_LOOP_RULES.HOLD_WINDOW_MS < PROJECTIOND_CIRCUIT_BREAKER.OPEN_COOLDOWN_MS,
    'the hold window is not strictly shorter than the cooldown it is supposed to sit inside');
  assert(RELIABILITY_LOOP_RULES.HOLD_WINDOW_MS > 0, 'a hold of no time measures nothing');
  const body = functionBodyOf(read(GATE), 'arm_A4');
  assert(body.includes('RL_HOLD_WINDOW_MS'),
    'the outage arm does not bound its hold by the derived window');
  // ...AND THE ENDPOINT IS MADE HEALTHY BEFORE THE PROBE, NOT AFTER. Restoring it later would send the one
  // half-open probe at a broken endpoint, and the breaker would correctly re-open for another cooldown.
  //
  // THE ORDER IS TAKEN OVER EXECUTABLE TEXT, WHICH IS THE SAME LESSON THE A3 PIN BELOW RECORDS ABOUT
  // ITSELF. Read over the whole body, this check failed against a CORRECT gate the moment a comment
  // explaining where the recovery measurement lives happened to name the id before the hold ran. A comment
  // may say an id; only executable text may be ordered by it.
  const executable = shellCodeOf(body);
  const restoreAt = executable.indexOf('chmod 0600');
  const holdAt = executable.indexOf('hold_until');
  const releaseAt = executable.indexOf('RL-F-A4-recovery-ms');
  assert(holdAt > 0 && restoreAt > holdAt && releaseAt > restoreAt,
    'the credential is not restored between the hold and the recovery measurement');
});

test('the rotation arm cannot open the breaker the outage arm is about', () => {
  assert(ROTATION_REFUSAL_BELOW_BREAKER,
    'the rotation refusal bound is not strictly under the breaker threshold, so A5 would be measuring A4');
  assert(RELIABILITY_LOOP_RULES.ROTATION_REFUSAL_READS_MAX < PROJECTIOND_CIRCUIT_BREAKER.FAILURE_THRESHOLD,
    'the refusal read bound reaches the breaker threshold');
});

// THE FLOORS THEMSELVES DID NOT MOVE, which is what makes every historical Phase 1 and Phase 2 result mean
// exactly what it meant before this tranche existed.
test('this tranche moved no Phase 1 or Phase 2 constant', () => {
  assertEq(PROJECTIOND_READ_POLICY.READ_DEADLINE_MS, 20_000, 'the read deadline');
  assertEq(PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS, 5_000, 'the admission queue wait');
  assertEq(PROJECTIOND_CIRCUIT_BREAKER.FAILURE_THRESHOLD, 5, 'the breaker failure threshold');
  assertEq(PROJECTIOND_CIRCUIT_BREAKER.OPEN_COOLDOWN_MS, 60_000, 'the breaker cooldown');
  assertEq(PROJECTIOND_CIRCUIT_BREAKER.HALF_OPEN_PROBES, 1, 'the half-open probe count');
  assertEq(PROJECTION_PHASE_1_BUDGETS.MAX_LIBRARY_CHURN_ITEMS, 0, 'the churn budget');
});

test('the contract document and the module agree on every number', () => {
  const doc = read(DOC);
  const expected: Array<[string, number]> = [
    ['CYCLES_PER_RUN', RELIABILITY_LOOP_RULES.CYCLES_PER_RUN],
    ['CONSECUTIVE_FRESH_RUNS', RELIABILITY_LOOP_RULES.CONSECUTIVE_FRESH_RUNS],
    ['READY_BUDGET_MS', RELIABILITY_LOOP_RULES.READY_BUDGET_MS],
    ['READ_FAIL_BUDGET_MS', RELIABILITY_LOOP_RULES.READ_FAIL_BUDGET_MS],
    ['BREAKER_REFUSAL_BUDGET_MS', RELIABILITY_LOOP_RULES.BREAKER_REFUSAL_BUDGET_MS],
    ['OUTAGE_RECOVERY_BUDGET_MS', RELIABILITY_LOOP_RULES.OUTAGE_RECOVERY_BUDGET_MS],
    ['ROTATION_CONVERGENCE_READS', RELIABILITY_LOOP_RULES.ROTATION_CONVERGENCE_READS],
    ['ROTATION_REFUSAL_READS_MAX', RELIABILITY_LOOP_RULES.ROTATION_REFUSAL_READS_MAX],
    ['ROTATION_READ_SPACING_MS', RELIABILITY_LOOP_RULES.ROTATION_READ_SPACING_MS],
    ['PLAY_START_BUDGET_MS', RELIABILITY_LOOP_RULES.PLAY_START_BUDGET_MS],
    ['PLAY_DECODED_SECONDS_MIN', RELIABILITY_LOOP_RULES.PLAY_DECODED_SECONDS_MIN],
  ];
  for (const [name, value] of expected) {
    // The document writes thousands with commas, as documents do; the module does not.
    const row = new RegExp(`\`${name}\`\\s*\\|\\s*\\*\\*([0-9,]+)\\*\\*`).exec(doc);
    assert(row !== null, `${name} has no row in the contract's threshold table`);
    assertEq(Number((row[1] as string).replace(/,/g, '')), value,
      `the contract and the module disagree about ${name}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The gate restates no threshold
// ---------------------------------------------------------------------------------------------------------

test('the gate spells none of the budget numbers, and reads them out of the module instead', () => {
  const gate = read(GATE);
  // The `eval` of the module's own output is the only place a number enters the shell.
  assert(/RL_BUDGETS="\$\(npx tsx src\/ops\/projection-reliability-loop-cli\.ts budgets --sh\)"/.test(gate),
    'the gate does not read its thresholds out of the module');
  assert(gate.includes('eval "$RL_BUDGETS"'), 'the gate does not evaluate the thresholds it read');

  // AND NO LITERAL SPELLING OF ANY OF THEM APPEARS ANYWHERE IN IT. Ports, container names and the shell's
  // own numbers are exempt by construction: none of the values below is small enough to collide with one.
  const forbidden = new Set<number>();
  for (const [key, value] of Object.entries(RELIABILITY_LOOP_RULES)) {
    if (typeof value === 'number' && value >= 1_000) forbidden.add(value);
    void key;
  }
  for (const value of forbidden) {
    const literal = new RegExp(`(^|[^0-9_.])${value}([^0-9_]|$)`, 'm');
    const offending = gate.split('\n')
      .map((line, index) => [index + 1, line] as const)
      // A COMMENT MAY SAY A NUMBER; ONLY EXECUTABLE TEXT MAY NOT. The rule is about drift between the shell
      // and the module, and prose that has to be read by a person is where the derivation is explained.
      .filter(([, line]) => !/^\s*#/.test(line))
      .filter(([, line]) => literal.test(line));
    assertEq(offending.length, 0,
      `the gate spells the budget ${value} literally at line(s) ${offending.map(([n]) => n).join(', ')}`);
  }
});

test('the gate configures its daemon with the poll interval the ready budget is derived from', () => {
  const gate = read(GATE);
  assert(gate.includes('DAEMON_POLL="$(( RL_POLL_INTERVAL_MS / 1000 ))s"'),
    'the daemon poll flag is not built from the interval the budget derives from');
  assert(gate.includes('--poll "$DAEMON_POLL"'), 'the daemon is not started with that interval');
  assert(!/--poll [0-9]/.test(gate), 'the gate hard-codes a poll interval somewhere');
});

// ---------------------------------------------------------------------------------------------------------
// The closure rule
// ---------------------------------------------------------------------------------------------------------

/** A results document in which every required id passes — the only shape that may ever close a run. */
function completeRun(): { cycles: Array<{ cycle: number; arm: string }>; results: Array<Record<string, unknown>> } {
  const cycles = RELIABILITY_LOOP_ARMS.map((arm, index) => ({ cycle: index + 1, arm }));
  const results: Array<Record<string, unknown>> = [];
  const add = (gate: string): void => {
    const key = budgetKeyFor(gate);
    if (key === undefined) {
      results.push({ gate, verdict: 'pass' });
      return;
    }
    const budget = RELIABILITY_LOOP_RULES[key] as number;
    // A measurement that satisfies whichever direction the id is compared in.
    results.push({ gate, verdict: 'pass', measured: budget, budget });
  };
  for (const record of cycles) for (const id of requiredCycleGateIds(record.cycle, record.arm)) add(id);
  for (const id of REQUIRED_RUN_GATE_IDS) add(id);
  return { cycles, results };
}

test('a complete run closes, and it is the only shape that does', () => {
  assertEq(reliabilityClosureProblems(completeRun() as never).length, 0,
    'a complete run does not satisfy its own closure rule');
});

test('a run that skipped an arm cannot close', () => {
  const document = completeRun();
  document.cycles = document.cycles.slice(0, 5);
  const problems = reliabilityClosureProblems(document as never);
  assert(problems.some((p) => p.includes('A6') && p.includes('never run')),
    `a missing arm was not named: ${problems.join(' | ')}`);
});

test('a run that ran one arm six times cannot close', () => {
  const document = completeRun();
  document.cycles = document.cycles.map((record) => ({ ...record, arm: 'A1' }));
  const problems = reliabilityClosureProblems(document as never);
  assert(problems.length > 0, 'six copies of one arm cleared the closure rule');
  assert(problems.some((p) => p.includes('where the contract names')),
    `the arm sequence was not compared: ${problems.slice(0, 3).join(' | ')}`);
});

test('a SKIP verdict on a required id is not a pass', () => {
  for (const target of ['RL-B-windows:c1', 'RL-F-A3-frontends-read-after-remount:c3',
    'RL-own-run-directory-removed']) {
    const document = completeRun();
    const hit = document.results.find((r) => r.gate === target);
    assert(hit !== undefined, `${target} is not in a complete run`);
    hit.verdict = 'skip';
    const problems = reliabilityClosureProblems(document as never);
    assert(problems.some((p) => p.startsWith(`${target} is skip`)),
      `a skipped ${target} closed the run: ${problems.join(' | ')}`);
  }
});

test('an ABSENT required id is not a pass either, which is the harder half', () => {
  const document = completeRun();
  document.results = document.results.filter((r) => r.gate !== 'RL-R-windows:c4');
  const problems = reliabilityClosureProblems(document as never);
  assert(problems.some((p) => p.startsWith('RL-R-windows:c4 is absent')),
    `a phase that never ran left nothing behind and closed the run: ${problems.join(' | ')}`);
});

test('a verdict measured against a budget the run supplied for itself is refused', () => {
  const document = completeRun();
  const hit = document.results.find((r) => r.gate === 'RL-R-ready-ms:c1');
  assert(hit !== undefined, 'the ready budget id is not in a complete run');
  hit.budget = 999_999;
  hit.measured = 500_000;
  const problems = reliabilityClosureProblems(document as never);
  assert(problems.some((p) => p.includes('where the contract names')),
    `a self-supplied budget was accepted: ${problems.join(' | ')}`);
});

test('two verdicts under one id are refused rather than the second overwriting the first', () => {
  const document = completeRun();
  document.results.push({ gate: 'RL-B-windows:c1', verdict: 'pass',
    measured: RELIABILITY_LOOP_RULES.OPERATOR_WINDOWS_REQUIRED,
    budget: RELIABILITY_LOOP_RULES.OPERATOR_WINDOWS_REQUIRED });
  const problems = reliabilityClosureProblems(document as never);
  assert(problems.some((p) => p.includes('two verdicts')), `a duplicate id was accepted: ${problems.join(' | ')}`);
});

test('a recorded failure OUTSIDE the required set still fails the run', () => {
  const document = completeRun();
  document.results.push({ gate: 'RL-something-nobody-required', verdict: 'fail' });
  const problems = reliabilityClosureProblems(document as never);
  assert(problems.some((p) => p.includes('RL-something-nobody-required')),
    'a failure outside the required set was ignored');
});

test('every arm requires its own middle, not just a summary verdict', () => {
  for (const arm of RELIABILITY_LOOP_ARMS) {
    const details = ARM_DETAIL_GATE_IDS[arm];
    assert(details.length >= 2, `${arm} has fewer than two measurements behind its summary`);
    const ids = requiredCycleGateIds(1, arm);
    for (const detail of details) {
      assert(ids.includes(`${detail}:c1`), `${arm} does not require ${detail}`);
    }
    assert(ids.includes(`RL-F-${arm}:c1`), `${arm} has no summary verdict`);
  }
});

test('every cycle requires all three servers, in both phases, in every way', () => {
  const ids = requiredCycleGateIds(2, 'A2');
  for (const server of RELIABILITY_SERVER_IDS) {
    for (const shape of ['RL-O-catalogue', 'RL-B-inread', 'RL-R-inread', 'RL-R-catalogue', 'RL-R-churn',
      'RL-O-play-start-ms', 'RL-O-play-decoded-seconds']) {
      assert(ids.includes(`${shape}:${server}:c2`), `${shape} is not required for ${server}`);
    }
  }
});

test('A3\'s three frontend checks read BYTES, never metadata', () => {
  // `test -r` WAS HERE AND IT IS METADATA. A dead FUSE mount answers `stat` from a warm attribute cache
  // while every `open` returns ENOTCONN, so the check carrying this arm's whole claim could have passed over
  // exactly the state it exists to detect — and on this arm two of three servers did report readable while
  // the namespace was gone. All three now run the same in-container program phases B and R use, against the
  // operator's approved windows, digest-compared to values recorded outside the mount.
  const body = shellCodeOf(functionBodyOf(read(GATE), 'arm_A3'));
  assert(!body.includes('test -r '),
    'A3 still decides a frontend can read from metadata; a dead mount answers stat from cache');
  assert(body.includes('sh /gate/inread.sh'),
    'A3 does not use the in-container approved-window read for its frontend checks');
  assert(body.includes('inread:ok'), 'A3 does not require the read program\'s own success token');
  // AND THE 3/3 REQUIREMENT IS EXACT AND UNCHANGED.
  assert(body.includes('RL-F-A3-frontends-read-after-remount') && body.includes('eq "$reading" 3'),
    'the three-of-three requirement is no longer an exact equality against 3');
});

test('A3 requires the assertion this whole tranche exists for', () => {
  // Phase 2's `--auto-remount` recovered the namespace for the daemon and for nobody else. The only check
  // that can tell those apart is three consumers reading through their own binds afterwards.
  assert(ARM_DETAIL_GATE_IDS.A3.includes('RL-F-A3-frontends-read-after-remount'),
    'A3 does not require the consumers to be able to read after the remount');
});

// ---------------------------------------------------------------------------------------------------------
// Containment of the one shared-code change
// ---------------------------------------------------------------------------------------------------------

test('--no-barrier reaches no gate but this one', () => {
  const dir = join(repoRoot, 'deploy');
  const offenders: string[] = [];
  for (const entry of readdirNames(dir)) {
    if (!entry.endsWith('.sh')) continue;
    if (entry === 'projection-reliability-loop-gate.sh') continue;
    if (read(`deploy/${entry}`).includes('--no-barrier')) offenders.push(entry);
  }
  assertEq(offenders.length, 0, `--no-barrier appears in ${offenders.join(', ')}`);
});

test('the barrier stays mandatory when nobody asks for it, and the pair is refused', () => {
  const cli = read('src/ops/projection-three-server-concurrency-cli.ts');
  assert(cli.includes("noBarrierRaw !== 'true'"),
    'the flag accepts values other than "true", so a present-but-negative value could choose a mode');
  assert(cli.includes("noBarrier ? undefined : need(args, 'endpoint')"),
    'the endpoint is not still required when the flag is absent');
  assert(cli.includes("noBarrier ? undefined : need(args, 'barrier-ref')"),
    'the barrier reference is not still required when the flag is absent');
  assert(/--no-barrier was passed together with/.test(cli),
    'passing the flag together with a barrier is not refused');
});

test('the overlap floors did not move, so no historical result means anything different', () => {
  const source = read('src/core/projection/three-server-concurrency.ts');
  assert(/MIN_SIMULTANEOUS_SAMPLES:\s*3\b/.test(source), 'the sample floor moved');
  assert(/MIN_SIMULTANEOUS_SPAN_SECONDS:\s*2\b/.test(source), 'the span floor moved');
});

test('the gate takes the overlap observation in measurement mode and says so', () => {
  const gate = read(GATE);
  assert(gate.includes('--overlap-mode measurement'), 'the gate does not use measurement mode');
  const doc = read(DOC);
  assert(/RECORDED, not required/i.test(doc), 'the contract does not say the overlap is recorded, not required');
});

// ---------------------------------------------------------------------------------------------------------
// The port block
// ---------------------------------------------------------------------------------------------------------

test('the port block collides with no other gate in deploy/, checked rather than commented', () => {
  const gate = read(GATE);
  const mine = new Set<string>();
  for (const match of gate.matchAll(/:-([0-9]{4,5})\}/g)) mine.add(match[1] as string);
  assert(mine.size >= 5, `only ${mine.size} default port(s) found in the gate; the block is not readable`);

  const others = new Set<string>();
  for (const entry of readdirNames(join(repoRoot, 'deploy'))) {
    if (!entry.endsWith('.sh')) continue;
    if (entry.startsWith('projection-reliability-loop-gate')) continue;
    for (const match of read(`deploy/${entry}`).matchAll(/:-([0-9]{4,5})\}/g)) others.add(match[1] as string);
  }
  const clash = [...mine].filter((port) => others.has(port));
  assertEq(clash.length, 0, `this gate's port(s) ${clash.join(', ')} are already claimed by another gate`);
});

test('the compose file takes its own project name, network and port', () => {
  const compose = read('docker-compose.projection-reliability.yml');
  assert(compose.includes('name: projection-reliability-gate'), 'the compose project name is shared');
  assert(compose.includes('PROJECTION_RELIABILITY_GATE_PG_PORT'), 'the database port is not overridable');
  assert(/postgres:16@sha256:[0-9a-f]{64}/.test(compose), 'the database image is not pinned by digest');
});

// ---------------------------------------------------------------------------------------------------------
// The shape rules every gate here is held to
// ---------------------------------------------------------------------------------------------------------

test('every heredoc in the gate is quoted', () => {
  // AN UNQUOTED HEREDOC RUNS `$(...)` AND EXPANDS `$VAR` AS IT IS WRITTEN, so a program the gate believes it
  // is shipping would be a program the shell had already rewritten.
  const gate = read(GATE);
  const unquoted = gate.split('\n')
    .map((line, index) => [index + 1, line] as const)
    .filter(([, line]) => /<<[A-Z]/.test(line) && !/<<'[A-Z]/.test(line));
  assertEq(unquoted.length, 0,
    `unquoted heredoc(s) at line(s) ${unquoted.map(([n]) => n).join(', ')}`);
});

test('every file the gate writes has a parent some earlier mkdir -p creates', () => {
  const gate = read(GATE);
  const made = new Set<string>();
  // BACKSLASH CONTINUATIONS ARE JOINED FIRST, AND THIS TEST FAILED FOR WANT OF IT ON ITS FIRST RUN. The
  // gate's `mkdir -p` lists eleven paths over three lines; a per-line scan reads `mkdir -p`, sees the first
  // few arguments and never looks at the ones on the continuations — which is exactly the defect the Phase 2
  // bake-off records as #7, where `config.json` was on the third line of such a list and the pin written to
  // catch it could not see it.
  const lines = gate.replace(/\\\n\s*/g, ' ').split('\n');
  const missing: string[] = [];
  for (const line of lines) {
    const mk = /^\s*mkdir -p (.+)$/.exec(line);
    if (mk !== null) {
      for (const raw of (mk[1] as string).matchAll(/"\$WORK\/([^"]+)"/g)) {
        // `-p` makes every ancestor too, so each one counts as created.
        const parts = (raw[1] as string).split('/');
        for (let index = 1; index <= parts.length; index += 1) made.add(parts.slice(0, index).join('/'));
      }
      continue;
    }
    const write = /^\s*cat > "\$WORK\/([^"]+)"/.exec(line);
    if (write === null) continue;
    const parent = (write[1] as string).split('/').slice(0, -1).join('/');
    if (parent !== '' && !made.has(parent)) missing.push(write[1] as string);
  }
  assertEq(missing.length, 0, `written with no mkdir for its parent: ${missing.join(', ')}`);
});

test('the whole gate parses as shell source under both line endings', () => {
  for (const [what, body] of [['LF', read(GATE)], ['CRLF', read(GATE).replace(/\n/g, '\r\n')]] as const) {
    // A file whose quotes do not close on their own line is one every "does this contain X" test skips over,
    // and Phase 2 found a harness whose two multi-line `node -e` arguments made the ENTIRE file unreadable.
    // `logicalLines` is where that is discovered — it joins continuations and refuses an unterminated quote —
    // so parsing alone would not have caught the defect this test exists for.
    const lines = logicalLines(parseShellSource(body, GATE));
    assert(lines.length > 0, `the gate produced no logical lines under ${what}`);
  }
});

test('the gate carries no NUL byte and no carriage return', () => {
  for (const path of [GATE, THREE, OPTIONAL]) {
    const raw = readFileSync(join(repoRoot, path));
    assertEq(raw.includes(0), false, `${path} holds a NUL byte, which makes it a binary file to every tool`);
    assertEq(raw.includes(0x0d), false, `${path} holds a CR; .gitattributes pins shipped shell to LF`);
  }
});

test('cleanup goes through the shared helper and the success path ASSERTS it', () => {
  const gate = read(GATE);
  assert(gate.includes('. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"'),
    'the gate does not source the shared cleanup contract');
  assert(gate.includes('projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE"'),
    'the gate does not clean up through the shared helper');
  assert(gate.includes('RL-own-mountpoints-removed'), 'the success path does not assert its own mountpoints');
  assert(gate.includes('RL-own-run-directory-removed'), 'the success path does not assert its own directory');
  assert(gate.includes('trap cleanup EXIT'), 'there is no failure-path cleanup');
});

test('the skip is 77, it comes before anything is built, and only :optional folds it', () => {
  const gate = read(GATE);
  assert(gate.includes('GATE_SKIP_STATUS=77'), 'the skip status is not 77');
  const skipAt = gate.indexOf('SKIPPED (status ${GATE_SKIP_STATUS}): the operator has supplied no');
  const buildAt = gate.indexOf('docker build -t "$IMAGE"');
  assert(skipAt > 0 && buildAt > skipAt, 'the corpus skip does not precede the image build');
  const three = read(THREE);
  assert(three.includes('exit "$GATE_SKIP_STATUS"'), 'the three-run wrapper folds a skip into success');
  assert(!/\bexit 0\b/.test(three.split('if [ "$status" -eq "$GATE_SKIP_STATUS" ]')[1] ?? ''),
    'the three-run wrapper exits 0 on a skip');
  const optional = read(OPTIONAL);
  assert(optional.includes('NOTHING WAS PROVED'), 'the optional wrapper does not say what a fold means');
});

test('the three-run wrapper cannot announce a sequence it did not complete', () => {
  const three = read(THREE);
  assert(three.includes('if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then'),
    'the closing message is not guarded by the completed count');
});

test('the three-run wrapper\'s accounting is EXECUTED against a scripted gate, not read', () => {
  // THE SEAM EXISTS FOR THIS. `PROJECTION_RELIABILITY_GATE_COMMAND` points the wrapper at a stub, so the
  // three things that matter — a skip propagates as 77, a failure stops the sequence, and the closing
  // message is guarded by the count — are exercised as BEHAVIOUR. Phase 1 spent four dispatches on programs
  // that were only ever matched by regex, and this is the wrapper that decides whether Phase 3 closes.
  const shell = findShell();
  if (shell === undefined) {
    skipBlock('executing the three-run wrapper against a stub gate (no POSIX shell for a temp path)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'rl-three-'));
  const stub = join(dir, 'stub.sh');
  const counter = join(dir, 'runs');
  const runWrapper = (statuses: string, runs: string): { status: number | null; out: string; calls: number } => {
    writeFileSync(counter, '');
    // A stub whose exit status is the Nth field of a script, so one wrapper run can be told to pass twice
    // and then skip.
    writeFileSync(stub, [
      'set -eu',
      `printf 'x' >> "${shPath(counter)}"`,
      `n="$(wc -c < "${shPath(counter)}" | tr -d " ")"`,
      `exit "$(echo "${statuses}" | cut -d, -f"$n")"`,
      '',
    ].join('\n'));
    const run = spawnSync(shell, [shPath(join(repoRoot, THREE))], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PROJECTION_RELIABILITY_GATE_COMMAND: shPath(stub),
        PROJECTION_RELIABILITY_GATE_RUNS: runs,
      },
    });
    return {
      status: run.status,
      out: `${run.stdout ?? ''}${run.stderr ?? ''}`,
      calls: readFileSync(counter, 'utf8').length,
    };
  };

  const green = runWrapper('0,0,0', '3');
  assertEq(green.status, 0, `three passing runs did not close: ${green.out}`);
  assertEq(green.calls, 3, 'the wrapper did not run the gate three times');
  assert(green.out.includes('3 of 3 consecutive reliability-loop runs completed'),
    `the closing message is missing: ${green.out}`);

  // A SKIP IS 77 AND IT STOPS THE SEQUENCE. Not folded, not tallied, not "two of three passed".
  const skipped = runWrapper('0,77,0', '3');
  assertEq(skipped.status, 77, 'a skipped run did not propagate 77');
  assertEq(skipped.calls, 2, 'the wrapper kept going after a skip');
  assert(!skipped.out.includes('consecutive reliability-loop runs completed'),
    'the wrapper announced a completed sequence over a skip');

  // A FAILURE STOPS IT TOO, and carries its own status out.
  const failed = runWrapper('0,1,0', '3');
  assertEq(failed.status, 1, 'a failing run did not propagate its status');
  assertEq(failed.calls, 2, 'the wrapper kept going after a failure');

  // AND A SEQUENCE OF NO RUNS CANNOT ANNOUNCE ONE.
  const none = runWrapper('0', '0');
  assert(none.status !== 0, 'a sequence of zero runs reported success');
  assert(none.out.includes('refusing to report a completed sequence'),
    `a zero-run sequence did not refuse: ${none.out}`);

  // THE OPTIONAL ENTRY POINT FOLDS A SKIP AND NOTHING ELSE.
  writeFileSync(counter, '');
  writeFileSync(stub, `set -eu\nexit 77\n`);
  const optional = spawnSync(shell, [shPath(join(repoRoot, OPTIONAL))], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PROJECTION_RELIABILITY_GATE_COMMAND: shPath(stub) },
  });
  assertEq(optional.status, 0, 'the optional entry point did not fold a skip');
  assert(`${optional.stdout ?? ''}${optional.stderr ?? ''}`.includes('NOTHING WAS PROVED'),
    'the optional entry point folded a skip without saying what that means');
  writeFileSync(stub, `set -eu\nexit 1\n`);
  const optionalFail = spawnSync(shell, [shPath(join(repoRoot, OPTIONAL))], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PROJECTION_RELIABILITY_GATE_COMMAND: shPath(stub) },
  });
  assertEq(optionalFail.status, 1, 'the optional entry point folded a FAILURE, not just a skip');
});

test('the operator inputs are copied at 0600 and the two consumers get different copies', () => {
  const gate = read(GATE);
  assert(gate.includes('install -m 600 "$TORBOX_CREDENTIAL" "$WORK/inputs/torbox-credential"'),
    'the provider credential is not installed at 0600');
  assert(gate.includes('install -m 600 "$GATE_SECRET" "$WORK/daemon-inputs/gate-secret"'),
    'the daemon does not get its own copy of the gate secret, so a rotation could not be staged');
  assert(gate.includes('chmod 700 "$WORK/inputs" "$WORK/daemon-inputs"'),
    'the secret directories are not 0700');
  // AND THE DAEMON NEVER SEES THE PROVIDER KEY. It is given `daemon-inputs`, which holds one file.
  assert(gate.includes('-v "$WORK/daemon-inputs:/var/lib/projectiond/inputs:ro"'),
    'the daemon is not given its own inputs directory');
  assert(!/-v "\$WORK\/inputs:\/var\/lib\/projectiond/.test(gate),
    'the daemon is given the directory that holds the provider API key');
});

test('the projected path is the gate\'s own, so the operator\'s label reaches no media server', () => {
  const gate = read(GATE);
  assert(gate.includes('Projection Real Object ${n} (2026)'),
    'the projected path is not built from a gate-chosen name');
  assert(gate.includes('needles.push(String(object.label))'),
    'the operator label is not searched for as a leak needle');
  assert(gate.includes('needles.push(String(object.ref))'),
    'the stable reference is not searched for as a leak needle');
});

// ---------------------------------------------------------------------------------------------------------
// The embedded programs, EXECUTED rather than grepped
// ---------------------------------------------------------------------------------------------------------

/** Pull one quoted heredoc out of the gate by its terminator, so the test runs the SHIPPED bytes. */
function embedded(name: string): string {
  const gate = read(GATE);
  const pattern = new RegExp(`<<'${name}'\\n([\\s\\S]*?)\\n${name}\\n`);
  const found = pattern.exec(gate);
  assert(found !== null, `the gate ships no program under the heredoc ${name}`);
  return found[1] as string;
}

function runNode(source: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const file = join(dir, 'program.cjs');
  writeFileSync(file, source);
  const run = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

test('record.cjs refuses a measurement that is not a number rather than scoring it as zero', () => {
  const source = embedded('RECORD');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const out = join(dir, 'results.jsonl');

  // A REAL MEASUREMENT PASSES.
  const good = runNode(source, [out, 'RL-x', 'le', '10', '20', 'a note']);
  assertEq(good.status, 0, `a satisfied budget did not pass: ${good.stdout}${good.stderr}`);

  // AN EMPTY ONE — exactly what a shell hands over when the command that was to measure produced nothing —
  // is a FAILURE naming the absence, not a zero that clears every ceiling.
  const empty = runNode(source, [out, 'RL-y', 'le', '', '20', 'a note']);
  assertEq(empty.status, 1, 'an absent measurement was not a failure');
  const lines = readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as
    { gate: string; verdict: string; note?: string });
  const absent = lines.find((line) => line.gate === 'RL-y');
  assert(absent !== undefined && absent.verdict === 'fail', 'the absent measurement was not recorded as fail');
  assert((absent.note ?? '').includes('not a number'), 'the failure does not say what was wrong');

  // AN UNKNOWN COMPARISON IS A FAILURE TOO, rather than defaulting to one of the three.
  const bogus = runNode(source, [out, 'RL-z', 'approximately', '10', '20']);
  assertEq(bogus.status, 1, 'an unknown comparison operator was accepted');
});

test('record.cjs bool refuses an observation that produced no value', () => {
  const source = embedded('RECORD');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const out = join(dir, 'results.jsonl');
  assertEq(runNode(source, [out, 'RL-a', 'bool', '1', '', 'note']).status, 0, 'a true observation failed');
  assertEq(runNode(source, [out, 'RL-b', 'bool', '0', '', 'note']).status, 1, 'a false observation passed');
  assertEq(runNode(source, [out, 'RL-c', 'bool', '', '', 'note']).status, 1,
    'an observation that produced nothing at all passed');
});

test('churn.cjs refuses an empty catalogue rather than scoring it as no churn', () => {
  const source = embedded('CHURN');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const full = join(dir, 'a.json');
  const empty = join(dir, 'b.json');
  writeFileSync(full, JSON.stringify([{ key: 'one' }, { key: 'two' }]));
  writeFileSync(empty, JSON.stringify([]));

  const same = runNode(source, [full, full]);
  assertEq(same.status, 0, `two identical catalogues failed: ${same.stderr}`);
  assertEq(same.stdout.trim(), '0', 'two identical catalogues did not report zero churn');

  const gone = runNode(source, [full, empty]);
  assertEq(gone.status, 1, 'an empty catalogue was compared instead of refused');
  assert(gone.stderr.includes('lists no entries'), `the refusal does not name the reason: ${gone.stderr}`);

  const drifted = join(dir, 'c.json');
  writeFileSync(drifted, JSON.stringify([{ key: 'one' }, { key: 'three' }]));
  const churned = runNode(source, [full, drifted]);
  assertEq(churned.stdout.trim(), '2', 'one added and one removed did not count as two');
});

test('summary.cjs prints nothing for a field it could not read, so absence is not a zero', () => {
  const source = embedded('SUMMARY');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const file = join(dir, 'summary.json');
  writeFileSync(file, JSON.stringify({ problems: 0, windowsMatched: 4 }));
  assertEq(runNode(source, [file, 'windowsMatched']).stdout.trim(), '4', 'a present field was not printed');
  assertEq(runNode(source, [file, 'nothingHere']).stdout.trim(), '', 'an absent field printed something');
  assertEq(runNode(source, [join(dir, 'missing.json'), 'problems']).stdout.trim(), '',
    'an unreadable file printed something');
});

test('oneread.cjs reports ok, mismatch and eio as three different things', () => {
  const source = embedded('ONEREAD');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const mount = join(dir, 'mnt');
  mkdirSync(join(mount, 'Movies', 'x'), { recursive: true });
  const body = Buffer.from('the bytes a window would hold, repeated enough to be a window'.repeat(20));
  writeFileSync(join(mount, 'Movies', 'x', 'x.mkv'), body);
  const digest = createHash('sha256').update(body.subarray(0, 64)).digest('hex');

  const corpus = join(dir, 'corpus.json');
  const describe = (sha: string, path: string): void => writeFileSync(corpus, JSON.stringify([{
    name: 'real-01', path, sizeBytes: body.length,
    probeDigests: [{ offset: 0, length: 64, sha256: sha }],
  }]));

  describe(digest, 'Movies/x/x.mkv');
  const ok = runNode(source, [corpus, mount]);
  assert(/^read:ok elapsedMs=[0-9]+/.test(ok.stdout.trim()), `a correct read did not say so: ${ok.stdout}`);

  describe('0'.repeat(64), 'Movies/x/x.mkv');
  const bad = runNode(source, [corpus, mount]);
  assert(bad.stdout.startsWith('read:mismatch'), `a wrong digest did not say so: ${bad.stdout}`);

  describe(digest, 'Movies/x/absent.mkv');
  const eio = runNode(source, [corpus, mount]);
  assert(bad.stdout !== eio.stdout && eio.stdout.startsWith('read:eio'),
    `an unreadable object did not report an errno: ${eio.stdout}`);
  assert(/elapsedMs=[0-9]+/.test(eio.stdout), 'a failed read reported no elapsed time');
});

test('corpus.cjs writes no reference and no operator label into the document everything else reads', () => {
  const source = embedded('CORPUS');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const objects = join(dir, 'objects.json');
  const endpoint = join(dir, 'endpoint.json');
  const out = join(dir, 'meta.json');
  writeFileSync(objects, JSON.stringify([{
    label: 'SECRETLABEL', ref: 'torbox:torrent:9999:8888', sizeBytes: 4096,
    probeDigests: [{ offset: 0, length: 64, sha256: 'a'.repeat(64) }],
  }]));
  writeFileSync(endpoint, JSON.stringify({ id: 'vault', allowedOrigins: ['https://example.invalid'] }));

  const run = runNode(source, [out, objects, endpoint]);
  assertEq(run.status, 0, `the corpus could not be described: ${run.stderr}`);
  const corpus = readFileSync(join(dir, 'corpus.json'), 'utf8');
  assert(!corpus.includes('SECRETLABEL'), 'the operator label reached the corpus document');
  assert(!corpus.includes('torbox:torrent'), 'the stable reference reached the corpus document');
  // ...and the reference IS in the batch, which is 0600 and only ever named by path.
  const batch = readFileSync(join(dir, 'register-batch.json'), 'utf8');
  assert(batch.includes('torbox:torrent:9999:8888'), 'the register batch lost the reference');

  // A WINDOW THAT ENDS PAST THE OBJECT IS REFUSED, because every offset downstream is the manifest's.
  writeFileSync(objects, JSON.stringify([{
    label: 'x', ref: 'torbox:torrent:1:2', sizeBytes: 100,
    probeDigests: [{ offset: 90, length: 64, sha256: 'b'.repeat(64) }],
  }]));
  assertEq(runNode(source, [out, objects, endpoint]).status, 1, 'a window past the end was accepted');
});

test('inread.sh compares every window and refuses a list it cannot read in full', () => {
  const shell = findShell();
  if (shell === undefined) {
    skipBlock('executing the in-container read program (no POSIX shell that can run a temp path)');
    return;
  }
  const source = embedded('INREAD');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const write = writeFileSync;
  const script = join(dir, 'inread.sh');
  write(script, source);
  const target = join(dir, 'object.bin');
  const body = Buffer.from('0123456789'.repeat(64));
  write(target, body);
  const digestOf = (offset: number, length: number): string =>
    createHash('sha256').update(body.subarray(offset, offset + length)).digest('hex');

  const windows = join(dir, 'windows.txt');
  const runIt = (): { status: number | null; stdout: string } => {
    const run = spawnSync(shell, [shPath(script), shPath(target), shPath(windows)],
      { encoding: 'utf8', timeout: 60_000 });
    return { status: run.status, stdout: `${run.stdout ?? ''}${run.stderr ?? ''}` };
  };

  write(windows, `0 32 ${digestOf(0, 32)}\n100 16 ${digestOf(100, 16)}\n`);
  const ok = runIt();
  assertEq(ok.status, 0, `two correct windows did not pass: ${ok.stdout}`);
  assert(ok.stdout.includes('inread:ok 2/2'), `the program did not count both windows: ${ok.stdout}`);

  // THE WINDOW IS SEEKED TO, NOT STREAMED TO, AND THAT IS THE DEFECT THAT COST A RUN. `tail -c +N` seeks in
  // GNU coreutils and READS AND DISCARDS in busybox — which Emby's image ships — so the first window of
  // this corpus, at offset 1,576,983,267 because the operator records them descending, streamed a gigabyte
  // and a half of a 1.7 GB object through a FUSE mount before the run was stopped by hand. The digest of a
  // window deep inside a file is what proves the seek: a program that streamed from zero would still
  // produce it, but only after reading everything before it, so the check that catches a REGRESSION is that
  // the primitive is `dd` with a byte-granular skip and that the program refuses a `dd` without one.
  assert(source.includes('iflag=skip_bytes,count_bytes'),
    'the in-container read does not use a byte-granular seek');
  assert(!/tail -c "\+/.test(source),
    'the in-container read still streams to its offset, which busybox does not seek for');
  assert(source.includes('inread:no-byte-granular-skip'),
    'the program does not refuse a dd that cannot seek by bytes; it would silently digest the wrong window');
  const deep = join(dir, 'deep.txt');
  write(deep, `600 24 ${digestOf(600, 24)}\n`);
  const seeked = spawnSync(shell, [shPath(script), shPath(target), shPath(deep)],
    { encoding: 'utf8', timeout: 60_000 });
  assertEq(seeked.status, 0,
    `a window deep inside the object was not read correctly: ${seeked.stdout}${seeked.stderr}`);

  // A SHORT READ IS NAMED RATHER THAN REPORTED AS A MISMATCH, because those are different diagnoses.
  const past = join(dir, 'past.txt');
  write(past, `630 64 ${'0'.repeat(64)}\n`);
  const short = spawnSync(shell, [shPath(script), shPath(target), shPath(past)],
    { encoding: 'utf8', timeout: 60_000 });
  assertEq(short.status, 1, 'a window running past the end of the object was accepted');
  assert(`${short.stdout}${short.stderr}`.includes('inread:short-read'),
    `a short read was not named: ${short.stdout}${short.stderr}`);

  // A WRONG DIGEST IS A MISMATCH AND NOT A PASS.
  write(windows, `0 32 ${'f'.repeat(64)}\n`);
  const bad = runIt();
  assertEq(bad.status, 1, 'a wrong digest passed');
  assert(bad.stdout.includes('inread:mismatch'), `the mismatch was not named: ${bad.stdout}`);

  // AN UNTERMINATED LIST SILENTLY DROPS ITS LAST RECORD IN EVERY READER, which would turn a four-window
  // check into a three-window one and still print inread:ok.
  write(windows, `0 32 ${digestOf(0, 32)}`);
  const unterminated = runIt();
  assertEq(unterminated.status, 1, 'an unterminated window list was read anyway');
  assert(unterminated.stdout.includes('inread:unterminated-window-list'),
    `the unterminated list was not named: ${unterminated.stdout}`);

  // AND AN EMPTY-BUT-TERMINATED LIST COMPARES NOTHING, which must not be a clean run.
  write(windows, '\n');
  const nothing = runIt();
  assertEq(nothing.status, 1, 'a list with no window in it reported a clean read');
});

test('needles.cjs refuses a needle too short to be decisive, and never prints one', () => {
  const source = embedded('NEEDLES');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const objects = join(dir, 'objects.json');
  const credential = join(dir, 'credential');
  const secret = join(dir, 'secret');
  const out = join(dir, 'needles.txt');
  writeFileSync(credential, 'a-long-enough-provider-key\n');
  writeFileSync(secret, 'a-long-enough-gate-secret\n');

  writeFileSync(objects, JSON.stringify([{ ref: 'torbox:torrent:1:2', label: 'LONGLABEL' }]));
  const good = runNode(source, [objects, credential, secret, out]);
  assertEq(good.status, 0, `a usable needle list was refused: ${good.stderr}`);
  const body = readFileSync(out, 'utf8');
  assertEq(body.endsWith('\n'), true,
    'the needle list does not end in a newline, so every reader drops its last needle');
  assertEq(body.trim().split('\n').length, 4, 'the list does not hold both refs and both secrets');

  writeFileSync(objects, JSON.stringify([{ ref: 'torbox:torrent:1:2', label: 'ab' }]));
  const short = runNode(source, [objects, credential, secret, out]);
  assertEq(short.status, 1, 'a two-byte needle was searched for anyway');
  assert(!short.stderr.includes('ab"') && !/needle.*\bab\b/.test(short.stderr),
    `the refusal printed the needle it refused: ${short.stderr}`);
});

test('mintsecret.cjs writes 0600 and produces a different value every time', () => {
  const source = embedded('MINTSECRET');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const out = join(dir, 'secret');
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertEq(runNode(source, [out]).status, 0, 'the secret could not be minted');
    const value = readFileSync(out, 'utf8').trim();
    assert(value.length >= 32, `a ${value.length}-byte secret is not high-entropy enough to be one`);
    seen.add(value);
  }
  assertEq(seen.size, 3, 'the same secret was minted twice, so a rotation would rotate nothing');
  // THE MODE IS THE HALF THAT MATTERS AND WIN32 CANNOT ANSWER IT. `SecretFile.loadLocked` refuses a
  // credential with `perm&0o077 != 0` — correctly, because a secret every user on the host can read is not
  // one — and the Phase 2 harness lost an arm to a token that was 0644. A Windows filesystem carries no
  // POSIX mode, so the check is SKIPPED BY NAME here rather than passing vacuously.
  if (process.platform === 'win32') {
    skipBlock('checking the minted secret is mode 0600 (win32 carries no POSIX mode)');
    return;
  }
  assertEq(statSync(out).mode & 0o077, 0, 'the minted secret is readable by group or other');
});

test('corpusfield.cjs answers only the fields it will vouch for', () => {
  const source = embedded('CORPUSFIELD');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const corpus = join(dir, 'corpus.json');
  writeFileSync(corpus, JSON.stringify([{
    name: 'Projection Real Object 01 (2026)', file: 'Projection Real Object 01 (2026).mkv',
    path: 'Movies/Projection Real Object 01 (2026)/Projection Real Object 01 (2026).mkv',
    sizeBytes: 100,
    probeDigests: [{ offset: 0, length: 8, sha256: 'a'.repeat(64) },
      { offset: 40, length: 8, sha256: 'b'.repeat(64) }],
  }]));
  assertEq(runNode(source, [corpus, 'file']).stdout.trim(), 'Projection Real Object 01 (2026).mkv',
    'the projected file name');
  const windows = runNode(source, [corpus, 'windows']).stdout.trim().split('\n');
  assertEq(windows.length, 2, 'the window list lost a window');
  assertEq(windows[0], `0 8 ${'a'.repeat(64)}`, 'the window list is not offset, length, digest');
  // A FIELD THIS PROGRAM WILL NOT VOUCH FOR IS A FAILURE, not an empty line a shell would read as a value.
  assertEq(runNode(source, [corpus, 'label']).status, 1,
    'the program answered for a field it does not own; the operator label must never leave the batch');
});

test('the gate ships no multi-line `node -e`, which is what made a Phase 2 harness unreadable', () => {
  // `parseShellSource` stops at an unterminated quote, so a multi-line `-e` argument makes the WHOLE file
  // unreadable and every "does this script contain X" test in this repository silently skips it. That is the
  // bake-off's own closing finding, and the rule is enforced here as a class rather than as a fixed line.
  for (const path of [GATE, THREE, OPTIONAL]) {
    const offending = read(path).split('\n')
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => /node -e/.test(line) && !/^\s*#/.test(line))
      .filter(([, line]) => {
        const quotes = (line.match(/"/g) ?? []).length;
        return quotes % 2 !== 0;
      });
    assertEq(offending.length, 0,
      `${path} carries a multi-line node -e at line(s) ${offending.map(([n]) => n).join(', ')}`);
  }
});

test('nothing warms the window before the cold concurrent scan measures it', () => {
  // THE FIRST REAL RUN DIED HERE. The three per-server `scan` calls that produce the item ids playback needs
  // are also the first thing that reads a 1.7 GB remote object through three ffprobes — Plex's took 15 s.
  // They ran BEFORE the loop, so by the time cycle 1's concurrent scan was observed every window was warm,
  // all three servers finished a two-entry re-scan between two ticks, and the run failed its own
  // simultaneity assertion having warmed the very window it was about to measure. G18's header warns about
  // exactly this; the warning was rediscovered by running the gate rather than by reading it.
  const gate = read(GATE);
  const scanAt = gate.indexOf('--out "$REL/out/items-jellyfin.json"');
  assert(scanAt > 0, 'the gate no longer produces item ids through each server\'s own scan');
  const fnAt = gate.indexOf('ensure_items() {');
  assert(fnAt > 0 && fnAt < scanAt,
    'the item-id scans are not inside ensure_items, so nothing bounds when they run');

  const overlapAt = gate.indexOf('drive verify-overlap');
  const callAt = gate.indexOf('\n  ensure_items\n');
  assert(overlapAt > 0, 'the gate no longer takes the overlap observation');
  assert(callAt > overlapAt,
    'ensure_items is called before the overlap observation, which warms the window it measures');

  // AND THERE IS EXACTLY ONE CALL SITE. A second one anywhere earlier would reintroduce the defect while
  // leaving the ordering check above satisfied.
  const calls = gate.split('\n').filter((line) => /^\s*ensure_items\s*$/.test(line));
  assertEq(calls.length, 1, `ensure_items is called ${calls.length} times; one call site, inside the loop`);
});

test('the play call supplies every flag each driver actually requires', () => {
  // THE SECOND REAL RUN DIED ON A MISSING FLAG, and the class rather than the instance is what is pinned:
  // the three drivers' `paced-play` do NOT take the same arguments — Emby needs `--local-work-dir` beside
  // `--work-dir`, because one is the spelling Docker bind-mounts and the other is the spelling the process
  // opens — and a call site written from one driver's signature is a call site that fails on the others.
  // So the required set is read out of each CLI's own source rather than listed here.
  const body = functionBodyOf(read(GATE), 'phase_play');
  for (const server of RELIABILITY_SERVER_IDS) {
    const cli = read(`src/ops/projection-${server}-dataplane-cli.ts`);
    const block = /case 'paced-play': \{([\s\S]*?)\n    case '/.exec(cli);
    assert(block !== null, `${server}'s CLI has no paced-play block to read a signature from`);
    const required = new Set<string>();
    for (const hit of (block[1] as string).matchAll(/need\(args, '([a-z-]+)'\)/g)) {
      required.add(hit[1] as string);
    }
    assert(required.size >= 8, `${server}'s paced-play signature read as only ${required.size} flag(s)`);
    for (const flag of required) {
      assert(body.includes(`--${flag} `), `the gate never passes --${flag}, which ${server} requires`);
    }
  }
});

test('a failing verdict never swallows the diagnosis that follows it', () => {
  // THE DEFECT THIS CLOSES COST A DIAGNOSIS ON A REAL RUN. `record` returns non-zero for a failed verdict,
  // and under `set -e` an unguarded one ends the script THERE — before the `die` that says what the failure
  // means, before the decoder's own words, before anything is preserved. The gate exited with a bare status
  // and a one-line verdict, and the one case the diagnostic existed for produced no diagnostic. It is Phase
  // 1 §6.15 #5's shape: the evidence path is the path that fails.
  //
  // Pinned as a CLASS over the whole file, because there were six of them and the next one will not be in
  // any of the six places.
  const offending = read(GATE).split('\n')
    .map((line, index) => [index + 1, line] as const)
    .filter(([, line]) => /record .*\bbool 0\b/.test(line))
    .filter(([, line]) => !/^\s*#/.test(line))
    // A line continued with a backslash carries its guard on the next line, which is still one statement.
    .filter(([, line]) => !/\|\| true/.test(line) && !/\\\s*$/.test(line));
  assertEq(offending.length, 0,
    `a definitely-failing verdict is unguarded at line(s) ${offending.map(([n]) => n).join(', ')}; under `
    + 'set -e it ends the run before the message that explains it');
});

test('consumer attachment is a SHIPPED CONTRACT, not a fact about one gate', () => {
  // THE ORDERING REMEDY IS ONLY DEFENSIBLE IF IT IS THE PRODUCT'S RULE RATHER THAN THIS GATE'S HABIT. A gate
  // that quietly started its consumers earlier would be tuning the experiment; a contract that says every
  // consumer must attach before the first mount, with the gate as one instance of it, is a deployment
  // requirement somebody can act on.
  assertEq(PROJECTIOND_CONSUMER_ATTACHMENT.BIND_BEFORE_FIRST_MOUNT, true,
    'the contract no longer requires a consumer to attach before the first mount');
  assertEq(PROJECTIOND_CONSUMER_ATTACHMENT.BIND_PROPAGATION, 'rslave', 'the bind propagation changed');
  // THE PARENT-BIND REMEDY IS SUPERSEDED AND THE CONTRACT MUST KEEP SAYING SO. If this ever flips to the
  // parent, the topology behind every Phase 1 data-plane result changes and those results were not taken
  // on it — so the flip has to be a deliberate, visible edit that fails here first.
  assertEq(PROJECTIOND_CONSUMER_ATTACHMENT.BIND_TARGET, 'the-mountpoint-itself',
    'the contract now asks consumers to bind the parent, which changes the topology behind every Phase 1 '
    + 'data-plane result');
  assertEq(PROJECTIOND_CONSUMER_ATTACHMENT.REPAIRABLE_BY_THE_DAEMON, false,
    'the contract now claims the daemon can repair a late binder; nothing measured supports that');
  // THE THREE MAINTENANCE ACTIONS ARE ENUMERATED, and the one that survives is the one that STACKS.
  assert(PROJECTIOND_CONSUMER_ATTACHMENT.LATE_BINDER_SURVIVES.includes('daemon-sigkill-and-restart'),
    'the contract no longer records that a SIGKILL restart is survivable, which is why G12 always passed');
  for (const action of ['daemon-graceful-stop-and-restart', 'external-umount-with-auto-remount']) {
    assert(PROJECTIOND_CONSUMER_ATTACHMENT.LATE_BINDER_DOES_NOT_SURVIVE.includes(action as never),
      `the contract no longer records ${action} as fatal to a late binder`);
  }
  // ...AND THE TWO LISTS ARE DISJOINT, because an action that appears in both says nothing at all.
  for (const action of PROJECTIOND_CONSUMER_ATTACHMENT.LATE_BINDER_SURVIVES) {
    assert(!(PROJECTIOND_CONSUMER_ATTACHMENT.LATE_BINDER_DOES_NOT_SURVIVE as readonly string[])
      .includes(action), `${action} is recorded as both survivable and fatal`);
  }
  // THE PRODUCT CONTRACT DOCUMENT CARRIES IT TOO, including WHY the parent-bind remedy was superseded —
  // because a remedy replaced without a reason is how the next reader reinstates it.
  const contract = read('docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md');
  assert(/##\s*11\.\s*Consumer attachment/.test(contract),
    'the product contract has no consumer-attachment section');
  assert(/PARENT-BIND REMEDY IS SUPERSEDED/.test(contract),
    'the product contract does not record that the parent-bind remedy was superseded, or why');
  assert(contract.includes('PROJECTIOND_CONSUMER_ATTACHMENT'),
    'the product contract does not name the machine-readable half of itself');
});

test('the consumers bind the projected path BEFORE anything is mounted there', () => {
  // THIS ORDER IS THE WHOLE OF WHETHER A CONSUMER SURVIVES A REMOUNT, and it cost two arms before it was
  // understood. A bind taken while the path is a plain directory is a slave of the PARENT's peer group, so
  // every later mount at that path propagates in; a bind taken while a FUSE mount is already there is a
  // slave of THAT MOUNT's peer group only, and once the mount is gone nothing reaches it again. Measured on
  // the host with two otherwise identical consumers: the early one kept reading across a graceful restart
  // AND across an external umount with --auto-remount; the late one could do neither.
  //
  // It is checked as an ORDER rather than as a bind spelling, because the bind is unchanged — same source,
  // same target, same rslave. Only the moment differs, and only an order can express that.
  const gate = read(GATE);
  const lines = gate.split('\n');
  // THE TOP-LEVEL CALL, NOT THE FIRST OCCURRENCE — and this pin failed against the FIXED gate until it said
  // so. `start_daemon` is also called from inside `restart_daemon`, which is defined earlier, so "the first
  // line that is exactly start_daemon" is a call the arms make and not the one that first mounts anything.
  // It is anchored on the step header the top-level call sits under.
  const topLevel = (stepText: string, name: string): number => {
    const header = lines.findIndex((line) => line.startsWith(`step "${stepText}`));
    assert(header >= 0, `the gate has no step beginning "${stepText}"`);
    const at = lines.findIndex((line, index) => index > header && line.trim() === name);
    assert(at >= 0, `the gate never calls ${name} under that step`);
    return at;
  };
  const daemonAt = topLevel('mounting — the daemon gets the GATE SECRET', 'start_daemon');
  for (const server of ['start_jellyfin', 'start_emby', 'start_plex']) {
    const at = topLevel('THE THREE MEDIA SERVERS START FIRST', server);
    assert(at < daemonAt,
      `${server} runs after the daemon first mounts, so its bind follows a mount instead of the directory `
      + 'and it cannot survive a remount');
  }
  // ...and the functions are DEFINED before they are called, which bash resolves at call time and a
  // reordering can silently get wrong.
  for (const server of ['start_jellyfin', 'start_emby', 'start_plex']) {
    assert(gate.indexOf(`${server}() {`) < gate.indexOf(`\n${server}\n`),
      `${server} is called before it is defined`);
  }
});

test('each server is addressed the way its own gate says it must be', () => {
  const gate = read(GATE);
  const body = functionBodyOf(gate, 'stream_base_for');
  // PLEX BY ADDRESS, NEVER BY NAME: it answers 401 to a request whose Host header it does not recognise, and
  // the address is read per call because a restarted container can come back on a different one.
  assert(/NetworkSettings\.Networks/.test(body), 'Plex is not addressed by its address on the gate network');
  assert(body.includes('{{index .NetworkSettings.Networks'),
    'the Plex address is ranged over rather than indexed by the network name, so a second network glues two '
    + 'addresses together');
  // ...AND NOBODY IS HANDED LOOPBACK. From inside a consumer container, 127.0.0.1 is the consumer.
  assert(!/--stream-base "http:\/\/127\.0\.0\.1/.test(gate),
    'a consumer is handed a loopback stream base, which from inside its own container is itself');
  for (const [server, variable] of [['jellyfin', 'JF_CONTAINER'], ['emby', 'EMBY_CONTAINER']] as const) {
    assert(body.includes(`http://\${${variable}}:8096`),
      `${server} is not addressed by its container name on the gate network`);
  }
});

test('playfigures.cjs reads BOTH results formats the three drivers actually ship', () => {
  // THE THIRD REAL RUN DIED HERE, on a play that had just succeeded. Jellyfin's and Emby's `appendResult`
  // rewrite a JSON ARRAY; Plex's appends one JSON object per line. A reader that knew one threw on the
  // other, printed nothing, and failed two verdicts for a play whose own driver reported 1.42 s to first
  // frame and 30 decoded seconds. The fixture below is each driver's REAL id spelling, so a rename that
  // broke the match would fail here rather than on the host.
  const source = embedded('PLAYFIGURES');
  const dir = mkdtempSync(join(tmpdir(), 'rl-pin-'));
  const rows = [
    { gate: 'PX18-startup-seconds:abc', verdict: 'pass', measured: 1.42, budget: 10 },
    { gate: 'PX18-decoded-media-seconds:abc', verdict: 'pass', measured: 30, budget: 30 },
  ];
  const asArray = join(dir, 'array.json');
  const asLines = join(dir, 'lines.json');
  writeFileSync(asArray, JSON.stringify(rows, null, 2));
  writeFileSync(asLines, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  for (const [what, path] of [['a JSON array', asArray], ['JSON lines', asLines]] as const) {
    assertEq(runNode(source, [path, 'startupSeconds']).stdout.trim(), '1420',
      `${what}: startup was not read, or was not converted from seconds to milliseconds`);
    assertEq(runNode(source, [path, 'decodedSeconds']).stdout.trim(), '30',
      `${what}: decoded media seconds were not read`);
  }
  // AND EACH DRIVER'S OWN SPELLING IS MATCHED, not just the one that happened to be written first.
  for (const prefix of ['JD18-paced-play-', 'EM18-paced-play-', 'PX18-']) {
    const file = join(dir, `${prefix}.json`);
    writeFileSync(file, JSON.stringify([
      { gate: `${prefix}startup-seconds:x`, verdict: 'pass', measured: 2, budget: 10 },
      { gate: `${prefix}decoded-media-seconds:x`, verdict: 'pass', measured: 31, budget: 30 },
    ]));
    assertEq(runNode(source, [file, 'startupSeconds']).stdout.trim(), '2000', `${prefix} startup`);
    assertEq(runNode(source, [file, 'decodedSeconds']).stdout.trim(), '31', `${prefix} decoded`);
  }
  // A FILE WITH NEITHER FIGURE PRINTS NOTHING, so the caller records a failed measurement and not a zero.
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, '[]');
  assertEq(runNode(source, [empty, 'startupSeconds']).stdout.trim(), '',
    'an absent figure printed something, which a shell would read as a measurement');
});

test('fuse-abort.sh aborts ONLY this run\'s own projectiond connections, and is executed to prove it', () => {
  // THIS IS THE MOST DANGEROUS PROGRAM IN THE TRANCHE AND IT IS THE ONE LEAST SAFE TO TRUST ON A READING.
  // It writes to `/sys/fs/fuse/connections/<n>/abort`, and the host it runs on serves its array over shfs,
  // which is also FUSE. Aborting the wrong connection would take the operator's array offline. So the two
  // paths are arguments, and this test runs the SHIPPED bytes against a crafted mount table and a fake
  // connections tree, and checks what it wrote.
  const shell = findShell();
  if (shell === undefined) {
    skipBlock('executing the FUSE abort program (no POSIX shell that can run a temp path)');
    return;
  }
  const source = embedded('FUSEABORT');
  const dir = mkdtempSync(join(tmpdir(), 'rl-abort-'));
  const script = join(dir, 'fuse-abort.sh');
  writeFileSync(script, source);
  const conns = join(dir, 'connections');
  for (const minor of ['31', '32', '33', '77']) {
    mkdirSync(join(conns, minor), { recursive: true });
    writeFileSync(join(conns, minor, 'abort'), '');
  }
  const ROOT = '/gate/run-1/mnt';
  // A mount table with the run's own mount, a SECOND projectiond mount stacked on it, an shfs mount that is
  // ALSO under the root, and a projectiond mount belonging to somebody else outside it.
  const table = [
    `20 1 0:31 / ${ROOT} rw,relatime shared:2 - fuse.projectiond projectiond rw`,
    `21 20 0:32 / ${ROOT} rw,relatime shared:3 - fuse.projectiond projectiond rw`,
    `22 1 0:33 / ${ROOT}/nested rw,relatime - fuse.shfs shfs rw`,
    `23 1 0:77 / /mnt/user rw,relatime - fuse.shfs shfs rw`,
    `24 1 0:44 / /somewhere/else/mnt rw,relatime - fuse.projectiond projectiond rw`,
  ].join('\n');
  const mountinfo = join(dir, 'mountinfo');
  writeFileSync(mountinfo, `${table}\n`);

  const run = spawnSync(shell, [shPath(script), ROOT, shPath(mountinfo), shPath(conns)],
    { encoding: 'utf8', timeout: 60_000 });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assertEq(run.status, 0, `the abort refused a table it should have acted on: ${out}`);
  // ONE PER MOUNTPOINT, AND IT IS THE TOPMOST — the connection the daemon is actually serving.
  //
  // THE EARLIER CONTRACT WAS "EVERY MATCHING MOUNT" AND A REAL RUN RETIRED IT. By the time A3 runs, earlier
  // cycles have deliberately left corpses stacked at this mountpoint (A2 SIGKILLs without unmounting and the
  // restart stacks over what it left), so aborting everything tore down the live connection AND a corpse
  // that was already dead — a fault nobody named, and the arm stopped recovering from it.
  assert(out.includes('abort:done 1'),
    `it did not abort exactly the ONE live connection at the mountpoint: ${out}`);
  assertEq(readFileSync(join(conns, '32', 'abort'), 'utf8').trim(), '1',
    'the TOPMOST mount at the mountpoint — the one being served — was not the one aborted');
  assertEq(readFileSync(join(conns, '31', 'abort'), 'utf8'), '',
    'a corpse stacked UNDER the live mount was aborted; the arm is about a living daemon');
  // THE SHFS UNDER THE ROOT IS NOT THIS GATE'S TO TOUCH — the fstype guard, not the path guard, stops it.
  assertEq(readFileSync(join(conns, '33', 'abort'), 'utf8'), '',
    'an shfs connection UNDER the run root was aborted; the fstype guard does not hold');
  // ...AND NEITHER IS THE HOST'S ARRAY.
  assertEq(readFileSync(join(conns, '77', 'abort'), 'utf8'), '',
    'the host array\'s shfs connection was aborted, which would take the array offline');

  // A PROJECTIOND MOUNT OUTSIDE THE ROOT IS SOMEBODY ELSE'S RUN. The path guard is what stops it, and a
  // table containing ONLY that must abort nothing and say so rather than exiting 0 over an empty set.
  writeFileSync(mountinfo, '24 1 0:44 / /somewhere/else/mnt rw - fuse.projectiond projectiond rw\n');
  const outside = spawnSync(shell, [shPath(script), ROOT, shPath(mountinfo), shPath(conns)],
    { encoding: 'utf8', timeout: 60_000 });
  assertEq(outside.status, 1, 'a projectiond mount outside the run root was treated as this run\'s');
  assert(`${outside.stdout}${outside.stderr}`.includes('abort:none'),
    'nothing matched and the program did not say so');

  // AND A ROOT-PREFIX COLLISION IS NOT A MATCH: `/gate/run-1/mnt-other` merely starts with the same text.
  writeFileSync(mountinfo, `25 1 0:44 / ${ROOT}-other rw - fuse.projectiond projectiond rw\n`);
  const collide = spawnSync(shell, [shPath(script), ROOT, shPath(mountinfo), shPath(conns)],
    { encoding: 'utf8', timeout: 60_000 });
  assertEq(collide.status, 1,
    'a mountpoint that merely SHARES A PREFIX with the run root was treated as being under it');
});

test('A3 reads PERMANENT evidence, because /readyz clears the serve death the moment it remounts', () => {
  // THE DEFECT THIS CLOSES WAS IN THE MEASUREMENT AND COST TWO REAL RUNS. `ClearServeDeath()` runs as soon
  // as `remountLoop` succeeds, so `lastServeDeathAt` exists only BETWEEN the death and the remount — with
  // `--auto-remount` that window is routinely shorter than one poll. An assertion that samples for the
  // field is structurally unable to see it, and on the run where the fault demonstrably DID occur
  // (`abort:done 2`) it did not see it. The log lines are permanent and are the two halves the arm names.
  const body = functionBodyOf(read(GATE), 'arm_A3');
  assert(/grep -c 'serve loop died'/.test(body),
    'A3 does not read the serve death from the daemon log');
  assert(/grep -c 'remounted; serving generation'/.test(body),
    'A3 does not read the remount from the daemon log');
  // THE PROHIBITION IS ON EXECUTABLE TEXT, NOT ON EXPLAINING WHY — this check first failed against the
  // FIXED gate for naming the field in the comment that records the lesson.
  // with `includes` rather than with regexes, because every one of them is shell punctuation and an
  // earlier version of this test escaped them wrongly, matched nothing at all, and reported green for it.
  const executable = shellCodeOf(body);
  assert(!executable.includes('lastServeDeathAt'),
    'A3 still samples /readyz for a field the daemon clears on a successful remount');
  // BOTH ARE COUNTED FROM A BASELINE, so a line an earlier cycle left cannot be read as this cycle's.
  assert(executable.includes('deaths_before=') && executable.includes('-gt "$deaths_before"'),
    'the serve-death count is not compared against a pre-fault baseline');
  assert(executable.includes('remounts_before=') && executable.includes('-gt "$remounts_before"'),
    'the remount count is not compared against a pre-fault baseline');
  // AND "REMOUNTED IN PLACE" NEEDS BOTH THE DAEMON SAYING SO AND THE NAMESPACE BEING READABLE. A log line
  // without a readable namespace is Phase 2's own worst defect; a readable namespace without the line does
  // not say the daemon did it.
  assert(executable.includes('recovered && [ "$remount_logged" -eq 1 ]'),
    'remounted-in-place rests on only one of the two witnesses');
});

test('READINESS IS A BYTE, NOT A STAT, and it is read from the entry that needs no provider', () => {
  // THE DEFECT THIS CLOSES SCORED A CORRECT RECOVERY AS A FAILURE ON THE FIRST RUN THAT REACHED A3.
  // `await_recovery` was `await_path`, which is `test -f`, and a dead FUSE mount answers `stat` out of the
  // kernel's attribute cache for a full `attrTimeout` after the connection is gone — §13.6's warm-cache
  // asymmetry met from the other side. So the clock stopped over a corpse: 695 ms from before the abort to
  // "recovered", `remounted-in-place` judged against a daemon that had not remounted, and the three
  // consumers read before the new mount had propagated to them. An `open` is what a corpse refuses.
  const gate = read(GATE);
  const body = functionBodyOf(gate, 'await_readable');
  assert(/dd "if=\/mnt\/\$SEED_PATH"/.test(body),
    'the readiness probe does not open and read a byte, so a warm attribute cache can still answer it');
  // THE SEED AND NOT THE OPERATOR'S OBJECT, for three reasons that are all load-bearing: READY_BUDGET_MS is
  // derived with no endpoint on the path, a poll loop must not spend a metered account, and A4 has to be
  // able to measure a daemon coming back DURING its own deliberate provider outage.
  assert(!body.includes('$REAL_PATH'),
    'the readiness probe reads the operator\'s object, so it measures the provider and not the daemon');
  const recovery = shellCodeOf(functionBodyOf(gate, 'await_recovery'));
  assert(recovery.includes('await_readable'),
    'await_recovery still decides recovery from metadata');
  assert(!recovery.includes('await_path'),
    'await_recovery still calls the metadata probe');
});

test('A3 WAITS for the remount it is asking about rather than sampling once', () => {
  // The other half of the same defect: the remount counter was read the instant `await_recovery` returned,
  // and `await_recovery` returned over a warm cache — so the arm asked "has the daemon remounted yet?"
  // before it could possibly have, and recorded the answer as the verdict. The daemon writes the line when
  // the event happens; the event is what the arm is about, so the line is waited for.
  const body = shellCodeOf(functionBodyOf(read(GATE), 'arm_A3'));
  const wait = body.indexOf('-gt "$remounts_before"');
  const clock = body.indexOf('await_recovery');
  assert(wait >= 0 && clock >= 0, 'A3 no longer both waits for the remount and takes a recovery clock');
  assert(wait < clock,
    'A3 still samples the remount counter after the recovery clock instead of waiting for the event');
  assert(/while \[ "\$n" -lt 240 \][\s\S]{0,400}-gt "\$remounts_before"/.test(body),
    'the remount is not waited for under a bounded poll');
});

test('A4 measures daemon readiness where it can be measured, not across its own hold', () => {
  // A CHECK THAT COULD NOT PASS, WHICH IS THE MIRROR OF ONE THAT CANNOT FAIL. `RL-R-ready-ms` was clocked
  // from the daemon start at the top of A4 and taken at the BOTTOM, so it spanned the trip, the whole
  // HOLD_WINDOW_MS hold and the recovery, against READY_BUDGET_MS. The hold alone is longer than that
  // budget in every run that could ever be taken. Its first real execution recorded 34,081 against 22,000
  // while every other measurement in the arm passed.
  assert(RELIABILITY_LOOP_RULES.HOLD_WINDOW_MS > RELIABILITY_LOOP_RULES.READY_BUDGET_MS,
    'the derivation this pin rests on has changed: the hold no longer outlasts the readiness budget');
  const body = shellCodeOf(functionBodyOf(read(GATE), 'arm_A4'));
  const clock = body.indexOf('await_recovery "$DAEMON_STARTED_MS"');
  const hold = body.indexOf('hold_until');
  assert(clock >= 0, 'A4 takes no readiness measurement at all');
  assert(hold >= 0 && clock < hold,
    'A4 still measures its readiness across the hold that is longer than the budget it is compared against');
  assertEq(body.split('await_recovery').length - 1, 1,
    'A4 takes more than one readiness measurement, so which one lands in RL-R-ready-ms is an accident');
  // AND THE PROVIDER HALF IS STILL MEASURED, against the budget §4 names for this arm. Moving the readiness
  // clock must not quietly leave the outage recovery unbounded.
  assert(body.includes('RL_OUTAGE_RECOVERY_BUDGET_MS'),
    'A4 no longer bounds its outage recovery against its own budget');
});

test('A5 spaces its reads across the cooldown that decides whether a read may resolve at all', () => {
  // THE DERIVATION ABOVE THIS ONE IS SILENT ABOUT THE COOLDOWN AND A REAL RUN WALKED INTO THE GAP.
  // MAX_REFRESHES_PER_SOURCE_PER_COOLDOWN is 1, so a read issued inside REFRESH_COOLDOWN_MS of the last
  // refresh is refused by the daemon locally, never reaches the resolver, and cannot present a rotated
  // credential. Four reads inside a few seconds bought one resolution; the arm converged on nothing and
  // cycle 5's phase R came up three windows short one check later.
  assertEq(RELIABILITY_LOOP_RULES.ROTATION_READ_SPACING_MS,
    PROJECTIOND_ACCESS_RESOLUTION.REFRESH_COOLDOWN_MS,
    'the spacing is not the product\'s own refresh cooldown');
  const body = shellCodeOf(functionBodyOf(read(GATE), 'arm_A5'));
  assertEq(body.split('sleep "$(( RL_ROTATION_READ_SPACING_MS / 1000 ))"').length - 1, 2,
    'A5 does not space BOTH of its read halves across the refresh cooldown');
  // AND THE COUNTS DID NOT MOVE. Raising either one is the other way to make this arm pass, and it would be
  // a threshold fitted to a run.
  assertEq(RELIABILITY_LOOP_RULES.ROTATION_CONVERGENCE_READS,
    1 + PROJECTIOND_READ_POLICY.MAX_ACCESS_REFRESHES_PER_READ, 'the convergence count moved');
  assertEq(RELIABILITY_LOOP_RULES.ROTATION_REFUSAL_READS_MAX,
    1 + PROJECTIOND_READ_POLICY.MAX_ACCESS_REFRESHES_PER_READ, 'the refusal count moved');
});

test('A5\'s two remaining checks can each fail, and one of them consults the breaker it names', () => {
  const body = shellCodeOf(functionBodyOf(read(GATE), 'arm_A5'));
  // `le "$reads" 2` against a loop that stops at two is unfailable: a rotation that never converged
  // recorded 2/2 and passed. A non-convergence records an ABSENT measurement now — empty, which
  // `record.cjs` fails as a non-number, rather than an invented figure that argues about magnitude.
  assert(/RL-F-A5-convergence-reads[\s\S]{0,200}\[ "\$converged" -eq 1 \] && echo "\$reads" \|\| echo ""/
    .test(body),
    'the convergence count still passes for a rotation that never converged');
  // AND THE BREAKER CHECK CONSULTED NOTHING ABOUT THE BREAKER: it was `converged` under a second name, so
  // RL-F-A5 and RL-F-A5-breaker-stayed-closed were one measurement reported twice. An open breaker is
  // defined in A4 as zero requests reaching the endpoint's own log; a closed one is that same instrument
  // read the other way.
  const breaker = /RL-F-A5-breaker-stayed-closed[^\n]*\n?[^\n]*/.exec(body)?.[0] ?? '';
  assert(breaker.includes('requests_after - requests_before'),
    'the breaker check does not measure requests reaching the endpoint');
  assert(!/local closed=1/.test(body),
    'the breaker check is still convergence under a second name');
  assert(body.includes('requests_before="$(resolver_requests)"'),
    'the breaker check has no pre-fault baseline to count from');
});

test('A6 tells the restarted Plex which library it had, and asserts it still has one', () => {
  // THE FIRST SIX-ARM RUN EVER TAKEN DIED HERE, WITH ALL SIX ARMS PASSED. Plex's `bootstrap` builds a fresh
  // `GateState` from the base URL and writes it over the state file; it recovers `sectionId` only when
  // `--name` is supplied, and A6 supplied none. So the re-bootstrap the arm scores as "the frontend came
  // back" erased the section, every later Plex request addressed
  // `/library/sections/undefined/all`, and the run failed one phase later on "the three scans did not
  // complete" — a 404 standing in for a state file the gate had emptied itself.
  const gate = read(GATE);
  const body = shellCodeOf(functionBodyOf(gate, 'arm_A6'));
  assert(/plex bootstrap[\s\S]{0,120}--name "\$LIBRARY_NAME"/.test(body),
    'A6 re-bootstraps Plex without naming the library, so the section id is written away');
  // THE NAME IS SPELLED ONCE. Two spellings drift, and this drift surfaces as a 404 six cycles later.
  const executable = shellCodeOf(gate);
  assertEq(executable.split('LIBRARY_NAME="Projection Movies"').length - 1, 1,
    'the library name is not defined exactly once');
  assert(!/--name "Projection Movies"/.test(executable),
    'the library name is still spelled literally at a call site, so the two can drift apart');
  // AND THE RECOVERY IS ASSERTED. `resolveSectionId` answers undefined for a library it cannot find and
  // `bootstrap` writes that out without complaint, so the loss must be named where it happens.
  assert(body.includes('RL-F-A6-plex-section-survived'),
    'A6 does not assert that the restarted Plex still names its section');
  assert(ARM_DETAIL_GATE_IDS.A6.includes('RL-F-A6-plex-section-survived'),
    'the section-survived check is not required, so deleting it would fail nothing');
});

test('the CLI publishes the thresholds as shell assignments the gate can evaluate', () => {
  const run = spawnSync(process.execPath,
    ['--import', 'tsx', join(repoRoot, 'src/ops/projection-reliability-loop-cli.ts'), 'budgets', '--sh'],
    { encoding: 'utf8', cwd: repoRoot, timeout: 120_000 });
  if (run.status !== 0) {
    skipBlock(`executing the reliability-loop CLI (${(run.stderr ?? '').trim().slice(0, 120)})`);
    return;
  }
  const emitted = new Map<string, string>();
  for (const line of (run.stdout ?? '').split('\n')) {
    const match = /^RL_([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match !== null) emitted.set(match[1] as string, (match[2] as string).replace(/^'|'$/g, ''));
  }
  for (const [key, value] of Object.entries(RELIABILITY_LOOP_RULES)) {
    assertEq(emitted.get(key), String(value), `the CLI publishes a different ${key} than the module holds`);
  }
  assertEq(emitted.get('ARMS'), RELIABILITY_LOOP_ARMS.join(' '), 'the arm list');
  assertEq(emitted.get('SERVERS'), RELIABILITY_SERVER_IDS.join(' '), 'the server list');
  assertEq(emitted.get('POLL_INTERVAL_MS'), String(RELIABILITY_POLL_INTERVAL_MS), 'the poll interval');
});

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}

/**
 * A shell fragment with its comment lines removed.
 *
 * WHY IT IS A HELPER RATHER THAN AN EXPRESSION AT EACH CALL SITE. Several checks here forbid something from
 * appearing in *executable* text while deliberately allowing the comment that explains why — and the first
 * version of one of them dropped a backslash, filtered nothing, and reported green over a file it had not
 * really examined. One implementation, used by all of them, is one place for that to be wrong.
 */
function shellCodeOf(fragment: string): string {
  return fragment.split(/\r?\n/).filter((line) => !line.trim().startsWith('#')).join('\n');
}

/**
 * One shell function's body, by brace depth rather than by a closing-line pattern.
 *
 * A `grep` from `name() {` to the next `^}` finds the first nested block's close, not the function's, and
 * every assertion made over the short body it returns is an assertion about a fragment.
 */
function functionBodyOf(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  assert(start >= 0, `the gate ships no function called ${name}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} is never closed`);
}

/**
 * A POSIX shell that can actually execute a script at this host's temporary path.
 *
 * IT IS CHOSEN BY RUNNING ONE, NOT BY `process.platform`. That is `d4f3265`'s lesson applied rather than
 * restated: keyed on the platform this block would skip on the machine this work was done on, and a skip
 * that looks like a pass is the failure mode the whole suite is about.
 */
function findShell(): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'rl-shell-'));
  const probe = join(dir, 'probe.sh');
  writeFileSync(probe, 'echo shell-ok\n');
  for (const candidate of ['sh', 'bash', '/bin/sh', '/bin/bash']) {
    const run = spawnSync(candidate, [shPath(probe)], { encoding: 'utf8', timeout: 30_000 });
    if (run.status === 0 && (run.stdout ?? '').includes('shell-ok')) return candidate;
  }
  return undefined;
}

/** A path a POSIX shell on this host can open, whichever spelling the platform hands us. */
function shPath(path: string): string {
  return process.platform === 'win32'
    ? `/${path[0]?.toLowerCase() ?? 'c'}${path.slice(2).replace(/\\/g, '/')}`
    : path;
}

console.log(`\nProjection Phase 3 — the reliability loop: ${passed} passed, ${failed} failed`
  + (skippedBlocks.length > 0 ? `, ${skippedBlocks.length} block(s) skipped on ${process.platform}` : ''));
for (const what of skippedBlocks) console.log(`  skipped: ${what}`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`  FAILED: ${name}: ${String(error)}`);
  process.exit(1);
}
