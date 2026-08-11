import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROJECTIOND_MOUNT_OBSERVATION,
  READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE,
  PROJECTIOND_READ_POLICY,
} from '../src/core/projection/runtime-contract.js';

// Projection Phase 4 — the daemon says what is at its mount point, offline.
//
// WHAT THIS SUITE IS FOR. The tranche's whole claim is that `/readyz` gains an OBSERVATION without changing
// the BELIEF, so the two things most worth pinning are (a) the numbers, in one place, agreeing across the
// contract, the document and the Go source, and (b) that `ready` and `mounted` still mean what three closed
// phases measured them to mean. Everything else this file checks is downstream of those two.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const DOC = join(repoRoot, 'docs', 'PROJECTION_PHASE_4_MOUNT_TRUTH.md');
const DAEMON_GO = join(repoRoot, 'projectiond', 'internal', 'daemon', 'daemon.go');
const GATE = join(repoRoot, 'deploy', 'projection-mount-truth-gate.sh');

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
const skippedBlocks: string[] = [];

/**
 * Record that a block asserted NOTHING, and say so by name at the end.
 *
 * THE GATE'S OWN PINS ARE WRITTEN AND THE GATE IS NOT, and this is how that is stated out loud rather than
 * by their quietly passing. A pin that passes because its subject does not exist is the unfailable check
 * this repository has now found five separate times, so the alternative to a named skip here is not a green
 * suite — it is a green suite that means nothing.
 */
function skipBlock(what: string): never {
  throw new Skipped(what);
}

/** Every gate pin below is about this file; while it is absent they assert nothing and say so. */
const gateExists = (): boolean => existsSync(GATE);
const GATE_ABSENT = 'the gate arms — deploy/projection-mount-truth-gate.sh is NOT YET WRITTEN';

/** Thrown by skipBlock so a block that asserted nothing cannot be counted as one that passed. */
class Skipped extends Error {}

function test(name: string, body: () => void): void {
  try {
    body();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    if (error instanceof Skipped) {
      // A SKIP IS NOT A PASS AND IS NOT COUNTED AS ONE. It prints under its own word, it is listed again by
      // name in the summary, and the counts below say how many blocks asserted nothing.
      skippedBlocks.push(`${name} — ${error.message}`);
      console.log(`  SKIP  ${name}`);
      return;
    }
    failed += 1;
    failures.push([name, error]);
    console.log(`  FAIL  ${name}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const read = (path: string): string => readFileSync(path, 'utf8');

/** Shell comments explain; only executable text is held to the rules about what the gate may spell. */
const shellCodeOf = (source: string): string => source.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

console.log('\nProjection Phase 4 — the daemon says what is at its mount point\n');

// ---------------------------------------------------------------------------------------------------------
// The numbers, and the property that makes one of them mean anything
// ---------------------------------------------------------------------------------------------------------

test('the thresholds are what this tranche predeclared, and the derivations still derive', () => {
  assertEq(PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_INTERVAL_MS, 1_000, 'the sample interval');
  assertEq(PROJECTIOND_MOUNT_OBSERVATION.PROBE_TIMEOUT_MS, 2_000, 'the probe timeout');
  assertEq(PROJECTIOND_MOUNT_OBSERVATION.READYZ_LATENCY_BUDGET_MS, 1_000, 'the endpoint latency budget');
  // DERIVED MEANS DERIVED: a full interval may elapse before a probe starts, and it may take its timeout.
  assertEq(PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_MAX_AGE_MS,
    PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_INTERVAL_MS + PROJECTIOND_MOUNT_OBSERVATION.PROBE_TIMEOUT_MS,
    'the freshness ceiling is no longer its own derivation');
  assert(PROJECTIOND_MOUNT_OBSERVATION.SINGLE_FLIGHT,
    'single-flight is off, so a wedged mount would accumulate one stuck probe per interval');
});

test('the endpoint could not have waited for a probe, and that is a check rather than a comment', () => {
  // THE WHOLE POINT OF THE LATENCY BUDGET. If it ever stopped being strictly under the probe timeout, a
  // /readyz that blocked on the probe would satisfy its own budget and MT3 would quietly stop meaning
  // anything. It is the same shape as ROTATION_REFUSAL_BELOW_BREAKER.
  assert(READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE,
    'the latency budget is not strictly under the probe timeout, so MT3 can no longer catch an inline probe');
  assert(PROJECTIOND_MOUNT_OBSERVATION.READYZ_LATENCY_BUDGET_MS
    < PROJECTIOND_MOUNT_OBSERVATION.PROBE_TIMEOUT_MS, 'the budget reaches the probe timeout');
  // ...AND THE PROBE TIMEOUT IS FAR UNDER THE READ DEADLINE, or a wedged mount would look merely slow for
  // twenty seconds, which is the "above" bound §3 names for it.
  assert(PROJECTIOND_MOUNT_OBSERVATION.PROBE_TIMEOUT_MS < PROJECTIOND_READ_POLICY.READ_DEADLINE_MS,
    'the probe timeout reaches the read deadline');
});

test('the sampler states are the probe states plus exactly the two a sampler has', () => {
  const states = [...PROJECTIOND_MOUNT_OBSERVATION.STATES];
  // The four a PROBE can answer, SPELLED AS IT SPELLS THEM, so the field can always be traced back to
  // `fusefs.ProbeResult` and no second vocabulary exists for the same four states.
  for (const probeState of ['live-projectiond', 'stale-projectiond', 'empty', 'foreign']) {
    assert(states.includes(probeState as never), `the probe state ${probeState} is not reportable`);
  }
  // ...and the two only a SAMPLER has. `timeout` is a probe that overran; `unchecked` is one that never ran.
  // THEY ARE NOT INTERCHANGEABLE WITH A NEGATIVE RESULT, which is the failure this enumeration exists to
  // prevent: "we could not look" reported as "we looked and it is not live" is the did-not-look reading of
  // a zero, and this repository has found that shape four times already.
  assert(states.includes('timeout' as never), 'a probe that overran has no state of its own');
  assert(states.includes('unchecked' as never), 'never-sampled has no state of its own');
  assertEq(states.length, 6, 'the state set has grown or shrunk without this pin being updated');
});

// ---------------------------------------------------------------------------------------------------------
// The additive rule, which is what stops three closed phases from being re-litigated
// ---------------------------------------------------------------------------------------------------------

test('READY AND MOUNTED ARE UNTOUCHED, and the daemon source is what is asked', () => {
  assert(([...PROJECTIOND_MOUNT_OBSERVATION.DOES_NOT_CHANGE] as string[]).join(',') === 'ready,mounted',
    'the additive rule no longer names both fields it protects');
  const daemon = read(DAEMON_GO);
  // `mounted` is still the remembered boolean, and `ready` is still that AND no observed serve death. If a
  // later edit folded the observation into either, every gate in Phases 1-3 would be measuring something it
  // was never measured against — which is precisely the change §5 defers rather than makes.
  assert(/Mounted:\s+d\.mounted\.Load\(\),/.test(daemon),
    'status.mounted is no longer the remembered boolean the closed phases were measured against');
  assert(/status\.Ready = status\.Mounted && d\.serveDeath\.Load\(\) == nil/.test(daemon),
    'status.ready is no longer mounted AND the absence of an observed serve death');
});

test('the daemon spells the same two numbers this contract predeclares', () => {
  // THE CROSS-LANGUAGE PIN. The sampler's cadence and bound live in Go and are predeclared here, and a
  // number that exists twice is a number that drifts. `contract.generated.json` is the export boundary for
  // the constants the daemon reads at run time; these two are compiled in, so this is where they are held.
  const main = read(join(repoRoot, 'projectiond', 'cmd', 'projectiond', 'main.go'));
  const interval = /mountSampleInterval\s*=\s*(\d+)\s*\*\s*time\.Millisecond/.exec(main);
  const timeout = /mountProbeTimeout\s*=\s*(\d+)\s*\*\s*time\.Millisecond/.exec(main);
  if (interval === null || timeout === null) {
    throw new Error('the daemon no longer declares both sampler constants where this pin can read them');
  }
  assertEq(Number(interval[1]), PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_INTERVAL_MS,
    'the daemon and the contract disagree about the sample interval');
  assertEq(Number(timeout[1]), PROJECTIOND_MOUNT_OBSERVATION.PROBE_TIMEOUT_MS,
    'the daemon and the contract disagree about the probe timeout');
  // ...AND THEY ARE NOT FLAGS. An operator who could widen the probe timeout could make a wedged mount look
  // merely slow, and the observation's whole value is that its bound is a property of the product.
  assert(!/flag\.(Duration|Int)\([^)]*mount-(sample|probe)/.test(main),
    'the sampler cadence or bound became a flag, so a deployment can now decide what the product means');
});

test('the sampler is single-flight in the daemon, not merely sequential in its loop', () => {
  // THE DEFECT THIS PINS WAS MINE, AND THE GO TEST CAUGHT IT BEFORE ANY HOST DID. The first implementation
  // relied on the loop being sequential, which bounds concurrent WAITING and not concurrent PROBING: giving
  // up on a probe does not stop it, so every tick against a wedged mount still started another goroutine.
  const daemon = read(DAEMON_GO);
  assert(/probeInFlight\.CompareAndSwap\(false, true\)/.test(daemon),
    'the sampler no longer refuses to start a second probe while one is outstanding');
  assert(/defer d\.probeInFlight\.Store\(false\)/.test(daemon),
    'the in-flight flag is not released by the probe goroutine itself');
});

// ---------------------------------------------------------------------------------------------------------
// The document restates nothing from memory
// ---------------------------------------------------------------------------------------------------------

test('the contract document and the module agree on every number', () => {
  const doc = read(DOC);
  const expected: Array<[string, number]> = [
    ['SAMPLE_INTERVAL_MS', PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_INTERVAL_MS],
    ['PROBE_TIMEOUT_MS', PROJECTIOND_MOUNT_OBSERVATION.PROBE_TIMEOUT_MS],
    ['SAMPLE_MAX_AGE_MS', PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_MAX_AGE_MS],
    ['READYZ_LATENCY_BUDGET_MS', PROJECTIOND_MOUNT_OBSERVATION.READYZ_LATENCY_BUDGET_MS],
  ];
  for (const [name, value] of expected) {
    const row = new RegExp(`\`${name}\`\\s*\\|\\s*\\*\\*([0-9,]+)\\*\\*`).exec(doc);
    if (row === null) throw new Error(`${name} has no row in the threshold table`);
    assertEq(Number((row[1] as string).replace(/,/g, '')), value,
      `the document and the module disagree about ${name}`);
  }
});

test('the document says NOT RUN until a run says otherwise, and keeps its nonclaims', () => {
  const doc = read(DOC);
  // A run record is the one part of a predeclared document that may not be optimistic in advance.
  assert(/## 6\. Run record[\s\S]{0,200}\*\*NOT RUN\.\*\*/.test(doc) || /1\/3 \| — /.test(doc)
    || /1\/3 \| Unraid/.test(doc), 'the run record neither says NOT RUN nor records a run');
  // THE NONCLAIMS ARE LOAD-BEARING and are the reason this tranche is allowed to be small.
  for (const phrase of ['closes only itself', 'A field is not a recovery',
    'still means what it meant', 'not a load test']) {
    assert(doc.includes(phrase), `the nonclaim "${phrase}" has been dropped from the document`);
  }
  assert(/G7–G13, G18 or G22/.test(doc), 'the document no longer says which G-numbers it does not close');
});

// ---------------------------------------------------------------------------------------------------------
// The gate, once it exists
// ---------------------------------------------------------------------------------------------------------

test('the gate is provider-free BY CONSTRUCTION, not by intention', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const gate = shellCodeOf(read(GATE));
  // No credential, no operator corpus, no endpoint. The daemon's configuration must name no endpoint at all,
  // so there is nothing it could contact even if an arm were wrong.
  for (const forbidden of ['torbox-credential', 'gate-secret', 'objects.json', 'endpoint.json',
    'PROJECTION_TORBOX_INPUT_DIR']) {
    assert(!gate.includes(forbidden),
      `the gate references ${forbidden}, so it is not provider-free by construction`);
  }
});

test('the gate binds its consumer BEFORE the first mount, and reads BYTES', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const gate = shellCodeOf(read(GATE));
  // §11 of the Phase 0 contract: a consumer that attaches after the daemon has mounted cannot follow a
  // remount, and no daemon behaviour can make it. MT4 is about a consumer surviving a recovery, so the
  // consumer has to have attached correctly or the arm measures the attachment bug instead.
  assert(gate.includes('rslave'), 'the consumer does not bind rslave');
  // ...AND IT READS BYTES. A dead FUSE mount answers stat from a warm attribute cache while every open
  // returns ENOTCONN, so `test -f` would pass over the exact state this gate exists to detect.
  assert(/\bdd\b|head -c|inread/.test(gate),
    'the consumer check is metadata, which a corpse answers from a warm attribute cache');
  assert(!/test -f .*REAL_PATH/.test(gate), 'a byte check was replaced by a metadata one');
});

test('the gate spells none of the thresholds and reads them from the module instead', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const gate = read(GATE);
  const executable = shellCodeOf(gate);
  const forbidden = new Set<number>();
  for (const value of Object.values(PROJECTIOND_MOUNT_OBSERVATION)) {
    if (typeof value === 'number' && value >= 1_000) forbidden.add(value);
  }
  for (const value of forbidden) {
    const literal = new RegExp(`(^|[^0-9_.])${value}([^0-9_]|$)`, 'm');
    // THE LINE NUMBERS ARE THE FILE'S, WHICH MEANS INDEXING BEFORE FILTERING. Numbering the comment-stripped
    // text instead reports lines that point at unrelated code, and a diagnostic that sends the reader to the
    // wrong line costs more than no diagnostic at all — measured, on the first run of this very pin.
    const offending = gate.split('\n')
      .map((line, index) => [index + 1, line] as const)
      // A COMMENT MAY SAY A NUMBER; ONLY EXECUTABLE TEXT MAY NOT. The rule is about drift between the shell
      // and the module, and prose is where the derivation gets explained.
      .filter(([, line]) => !/^\s*#/.test(line))
      // TWO FORMS ARE NOT RESTATEMENTS AND ARE NAMED RATHER THAN WAVED THROUGH, because one of the
      // thresholds here is 1,000 and that number has two other jobs in any shell that runs containers:
      //
      //   `1000:1000`  a uid:gid pair. The consumer runs unprivileged and its uid is not a budget.
      //   `/ 1000`     milliseconds to seconds. A unit conversion is arithmetic ON a threshold, not a second
      //                copy OF one — the gate still has to have read the threshold to divide it.
      //
      // Neither can hide a real restatement: a threshold used as a threshold appears as a bare comparison
      // operand (`-le 1000`), which neither pattern removes. Blanket-exempting "lines that look fine" would.
      .map(([n, line]) => [n, line.replace(/\b\d+:\d+\b/g, '').replace(/\/\s*1000\b/g, '')] as const)
      .filter(([, line]) => literal.test(line));
    assertEq(offending.length, 0,
      `the gate spells the threshold ${value} literally at line(s) ${offending.map(([n]) => n).join(', ')}`);
  }
});

test('the gate holds all six predeclared ids and cannot pass without its own control', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const executable = shellCodeOf(read(GATE));
  for (const id of ['MT1', 'MT2', 'MT3', 'MT4', 'MT5', 'MT6']) {
    assert(executable.includes(id), `the gate no longer records ${id}`);
  }
  // MT1 IS THE CONTROL AND IT IS NOT OPTIONAL. Without a live observation to compare against, every arm
  // below is satisfied by a daemon that answers "not live" unconditionally — which is the shape of check
  // this repository has now found unfailable four separate times.
  assert(/MT1[\s\S]{0,400}live/.test(executable),
    'MT1 no longer asserts a live observation, so the later arms have nothing to be different from');
});

// ---------------------------------------------------------------------------------------------------------

console.log(`\nProjection Phase 4 — the daemon says what is at its mount point: `
  + `${passed} passed, ${failed} failed`
  + (skippedBlocks.length > 0 ? `, ${skippedBlocks.length} block(s) SKIPPED and asserting nothing` : ""));
for (const what of skippedBlocks) console.log(`  skipped: ${what}`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`  FAILED: ${name}: ${String(error)}`);
  process.exit(1);
}
