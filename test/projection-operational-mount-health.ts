import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROJECTIOND_MOUNT_HEALTH,
  PROJECTIOND_MOUNT_OBSERVATION,
  PROJECTIOND_READ_POLICY,
  READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE,
  LIVEZ_CANNOT_HAVE_WAITED_FOR_A_PROBE,
  HEALTHCHECK_START_PERIOD_CLEARS_BOOTSTRAP_GRACE,
  HEALTHCHECK_TIMEOUT_CLEARS_READINESS_BUDGET,
  DAEMON_DECIDES_UNHEALTHY_NOT_DOCKER,
  MOUNT_HEALTH_POLICY_IS_BOUNDED_BY_ITS_SAMPLER,
} from '../src/core/projection/runtime-contract.js';

// Projection Phase 5 — the observation becomes operationally authoritative, offline.
//
// WHAT THIS SUITE IS FOR. The tranche's claim is that readiness now answers from the mount THROUGH A BOUNDED
// POLICY, and that liveness stopped being the same question. So the things most worth pinning are (a) the
// numbers and their derivations, in one place, agreeing across the contract, the document, the Go source, the
// image and the gate; (b) the precedence, which is the part of a state machine that silently inverts; and
// (c) that the liveness surface never learns to talk about the mount. Everything else is downstream.
//
// THE DEEP BEHAVIOURAL PROOF IS IN GO, NOT HERE. `projectiond/internal/daemon/readiness_test.go` drives the
// policy with a fake clock across every boundary either side of every threshold. This file is what stops the
// numbers and the shapes drifting apart between languages.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const DOC = join(repoRoot, 'docs', 'PROJECTION_PHASE_5_OPERATIONAL_MOUNT_HEALTH.md');
const DAEMON_GO = join(repoRoot, 'projectiond', 'internal', 'daemon', 'daemon.go');
const MAIN_GO = join(repoRoot, 'projectiond', 'cmd', 'projectiond', 'main.go');
const READINESS_TEST_GO = join(repoRoot, 'projectiond', 'internal', 'daemon', 'readiness_test.go');
const DOCKERFILE = join(repoRoot, 'projectiond', 'Dockerfile');
const GATE = join(repoRoot, 'deploy', 'projection-operational-mount-health-gate.sh');
const COMPOSE = join(repoRoot, 'docker-compose.projection-mount-health.yml');
const RELIABILITY_GATE = join(repoRoot, 'deploy', 'projection-reliability-loop-gate.sh');

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
const skippedBlocks: string[] = [];

/**
 * Record that a block asserted NOTHING, and say so by name at the end.
 *
 * A pin that passes because its subject does not exist is the unfailable check this repository has now found
 * five separate times, so the alternative to a named skip here is not a green suite — it is a green suite
 * that means nothing.
 */
function skipBlock(what: string): never {
  throw new Skipped(what);
}

const gateExists = (): boolean => existsSync(GATE);
const GATE_ABSENT = 'the gate arms — deploy/projection-operational-mount-health-gate.sh is NOT YET WRITTEN';

/** Thrown by skipBlock so a block that asserted nothing cannot be counted as one that passed. */
class Skipped extends Error {}

function test(name: string, body: () => void): void {
  try {
    body();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    if (error instanceof Skipped) {
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

console.log('\nProjection Phase 5 — the observation becomes operationally authoritative\n');

// ---------------------------------------------------------------------------------------------------------
// The numbers, and the derivations that make them mean anything
// ---------------------------------------------------------------------------------------------------------

test('the thresholds are what this tranche predeclared, and the derivations still derive', () => {
  assertEq(PROJECTIOND_MOUNT_HEALTH.MOUNT_BOOTSTRAP_GRACE_MS, 15_000, 'the bootstrap grace');
  assertEq(PROJECTIOND_MOUNT_HEALTH.LIVEZ_LATENCY_BUDGET_MS, 1_000, 'the liveness budget');
  assertEq(PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_INTERVAL_S, 10, 'the healthcheck interval');
  assertEq(PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_TIMEOUT_S, 5, 'the healthcheck timeout');
  assertEq(PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_START_PERIOD_S, 20, 'the healthcheck start period');
  assertEq(PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_RETRIES, 3, 'the healthcheck retries');

  // DERIVED MEANS DERIVED. A number that used to be derived and is now merely equal to its old value is a
  // number that will not move when its input does.
  assertEq(PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS,
    2 * PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_MAX_AGE_MS,
    'the fault hold is no longer two whole worst-case sampling windows');
  assertEq(PROJECTIOND_MOUNT_HEALTH.MOUNT_RECOVERY_CONFIRM_MS,
    PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_INTERVAL_MS,
    'the recovery confirmation is no longer one sample interval, so it can be satisfied by one sample');
  assertEq(PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_UNHEALTHY_BOUND_MS,
    PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS
      + (PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_RETRIES * PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_INTERVAL_S * 1_000)
      + (PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_TIMEOUT_S * 1_000),
    'the unhealthy bound is no longer the hold plus every retry plus one whole probe timeout');
});

test('PHASE 4 MOVED NO NUMBER, and this is the pin that says so', () => {
  // A TRANCHE THAT CHANGES SEMANTICS IS THE EASIEST PLACE TO QUIETLY MOVE A THRESHOLD, and §4 of the Phase 5
  // document states in as many words that none moved. If one had, every Phase 4 measurement would be about a
  // sampler that no longer exists, and the re-run recorded in the regression matrix would prove nothing.
  assertEq(PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_INTERVAL_MS, 1_000, 'Phase 4 sample interval');
  assertEq(PROJECTIOND_MOUNT_OBSERVATION.PROBE_TIMEOUT_MS, 2_000, 'Phase 4 probe timeout');
  assertEq(PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_MAX_AGE_MS, 3_000, 'Phase 4 freshness ceiling');
  assertEq(PROJECTIOND_MOUNT_OBSERVATION.READYZ_LATENCY_BUDGET_MS, 1_000, 'Phase 4 readiness budget');
});

test('every derived relation this tranche depends on is a check rather than a comment', () => {
  // EACH OF THESE, ALONE, IS WHAT STOPS ONE ARM QUIETLY MEASURING SOMETHING ELSE.
  assert(READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE, 'the readiness budget reaches the probe timeout');
  assert(LIVEZ_CANNOT_HAVE_WAITED_FOR_A_PROBE, 'the liveness budget reaches the probe timeout');
  assert(HEALTHCHECK_START_PERIOD_CLEARS_BOOTSTRAP_GRACE,
    'the healthcheck would count a probe the bootstrap grace answered, so a container could report healthy '
    + 'having never observed its mount');
  assert(HEALTHCHECK_TIMEOUT_CLEARS_READINESS_BUDGET,
    'an endpoint answering inside its own budget could be recorded as a healthcheck timeout');
  assert(DAEMON_DECIDES_UNHEALTHY_NOT_DOCKER,
    'Docker would call the container unhealthy before the daemon believed the fault, so the anti-flap policy '
    + 'would live in two places and therefore in neither');
  assert(MOUNT_HEALTH_POLICY_IS_BOUNDED_BY_ITS_SAMPLER,
    'the hold, the grace, the confirmation or the anti-flap transient no longer sits where its derivation '
    + 'puts it relative to the sampler');
  // ...AND THE PROBE TIMEOUT IS STILL FAR UNDER THE READ DEADLINE, or a wedged mount would look merely slow.
  assert(PROJECTIOND_MOUNT_OBSERVATION.PROBE_TIMEOUT_MS < PROJECTIOND_READ_POLICY.READ_DEADLINE_MS,
    'the probe timeout reaches the read deadline');
});

test('the anti-flap transient is bounded on BOTH sides, or the arm it feeds proves nothing', () => {
  // BELOW: shorter than a sample interval and the fault could pass entirely between two probes, so MH6 would
  // assert that readiness survived a fault the daemon never saw — which is the shape of check this repository
  // has found unfailable five times, and it is why MH6 also requires the fault to have been REPORTED.
  assert(PROJECTIOND_MOUNT_HEALTH.ANTI_FLAP_TRANSIENT_MS > PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_INTERVAL_MS,
    'the transient is no longer long enough to guarantee a probe lands on it');
  // ABOVE: long enough and readiness would be ENTITLED to go false, so a run in which it did would be the
  // product behaving correctly and the arm would be wrong to fail it.
  assert(PROJECTIOND_MOUNT_HEALTH.ANTI_FLAP_TRANSIENT_MS
    < PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS - PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_MAX_AGE_MS,
    'the transient can now legitimately outlast the fault hold, so MH6 could fail a correct daemon');
});

// ---------------------------------------------------------------------------------------------------------
// The reason codes: a closed set, in a precedence, carrying nothing
// ---------------------------------------------------------------------------------------------------------

test('the reason codes are a closed set and the daemon spells exactly the same eight', () => {
  const reasons = [...PROJECTIOND_MOUNT_HEALTH.READY_REASONS] as string[];
  assertEq(reasons.length, 8, 'the reason set has grown or shrunk without this pin being updated');
  assertEq(reasons[0], 'ok', 'the happy code is no longer first, so the precedence table has been reordered');
  const daemon = read(DAEMON_GO);
  for (const reason of reasons) {
    assert(daemon.includes(`"${reason}"`), `the daemon does not spell the reason code ${reason}`);
  }
  // ...AND NO NINTH ONE HAS APPEARED IN THE DAEMON WITHOUT THE CONTRACT LEARNING ABOUT IT. Every constant in
  // the ReadyReason block must be one the contract publishes, or the closed set is not closed.
  const block = /const \(\n(\s*ReadyReason[\s\S]*?)\n\)/.exec(daemon);
  if (block === null) throw new Error('the daemon no longer declares its reason codes in one block');
  for (const [, value] of (block[1] as string).matchAll(/ReadyReason\w+\s*=\s*"([^"]+)"/g)) {
    assert(reasons.includes(value as string),
      `the daemon has a reason code the contract does not publish: ${String(value)}`);
  }
});

test('THE REASON CODES CARRY NOTHING A DOCUMENT COULD NOT BE PASTED INTO AN ISSUE', () => {
  // A CODE IS SAFE BECAUSE OF WHAT IT CANNOT CONTAIN. These are constants, so the only way one leaks is if
  // somebody writes a leak into the constant — which is exactly what this refuses.
  for (const reason of PROJECTIOND_MOUNT_HEALTH.READY_REASONS) {
    assert(/^[a-z][a-z0-9-]*$/.test(reason),
      `the reason code ${reason} is not a plain lowercase code, so it could carry something`);
    for (const forbidden of ['/', '\\', ':', '@', '.', 'http', 'token', 'key', 'secret', 'origin']) {
      assert(!reason.includes(forbidden), `the reason code ${reason} contains ${forbidden}`);
    }
  }
});

test('the precedence puts direct evidence ahead of the lagging sample, and it is in that order', () => {
  // THE ORDER IS THE PART OF A STATE MACHINE THAT INVERTS SILENTLY. A serve-loop death the supervisor watched
  // is DIRECT evidence; the observation is a late sample of the same event. Reporting the sample first would
  // name the symptom and bury the cause, and nothing in a test that only checked membership would notice.
  const reasons = [...PROJECTIOND_MOUNT_HEALTH.READY_REASONS] as string[];
  const at = (reason: string): number => {
    const index = reasons.indexOf(reason);
    if (index < 0) throw new Error(`${reason} is no longer a reason code at all`);
    return index;
  };
  assert(at('no-generation-admitted') < at('serve-loop-dead'),
    'nothing-admitted no longer outranks a serve death');
  // A SERVE DEATH OUTRANKS `not-mounted`, AND THAT IS THE ONLY WAY IT IS EVER REPORTABLE. The supervisor runs
  // SetMounted(false) BEFORE RecordServeDeath and ClearServeDeath BEFORE SetMounted(true), so `mounted` is
  // false for the whole window a death is recorded in. Predeclared the other way round, `serve-loop-dead`
  // could never occur at all — measured on the first real Tower run, and corrected without moving a number.
  assert(at('serve-loop-dead') < at('not-mounted'),
    'not-mounted outranks a serve death again, which makes serve-loop-dead an unreportable code');
  for (const observationReason of ['mount-observed-not-live', 'mount-observation-stale',
    'mount-observation-unavailable', 'mount-recovering']) {
    assert(at('not-mounted') < at(observationReason),
      `the observation reason ${observationReason} now outranks a pre-existing readiness rule`);
  }
  // ...AND THE DAEMON EVALUATES THEM IN THE SAME ORDER. A contract that listed one order while the source
  // took another would be a document about a product that does not exist.
  const decide = read(DAEMON_GO).slice(read(DAEMON_GO).indexOf('func decideReadiness'));
  let cursor = -1;
  for (const reason of ['ReadyReasonNoGeneration', 'ReadyReasonServeLoopDead', 'ReadyReasonNotMounted']) {
    const found = decide.indexOf(reason);
    assert(found > cursor, `decideReadiness no longer returns ${reason} in the predeclared order`);
    cursor = found;
  }
});

test('THE ANTI-FLAP POLICY GUARDS BOTH DIRECTIONS AND CONTRADICTS ITSELF IN NEITHER', () => {
  // THE DEFECT THIS PINS WAS MINE, IT WAS PREDECLARED, AND THE GATE'S FIRST REAL RUN MEASURED IT. The
  // recovery confirmation was unconditional, which makes it the mirror image of the flap the fault hold
  // exists to prevent: any transient long enough to produce one non-live sample restarts the live run, so an
  // unconditional confirmation takes the appliance out of service for a whole second at the TAIL of every
  // transient whose front the hold had just protected. MH6 recorded `lostReady=1 (code 503)`.
  const daemon = read(DAEMON_GO);
  assert(/faultWasBelieved/.test(daemon),
    'the recovery confirmation is unconditional again, so it reintroduces the flap the fault hold prevents');
  assert(/faultWasBelieved && verdict\.liveRun < MountRecoveryConfirm/.test(daemon),
    'the confirmation no longer depends on whether readiness was actually withheld for the fault before it');
  // ...AND A RUN MAY NOT SPAN A DEATH. The supervisor remounts in about a second and the sampler probes once
  // a second, so an abort and its whole recovery can pass BETWEEN two samples — and then readiness returns on
  // an observation taken before the fault. Measured on Tower as a live run 72 seconds old vouching for a
  // recovery it predated, which is exactly Phase 2's worst defect wearing this tranche's new field.
  const store = daemon.slice(daemon.indexOf('func (d *Daemon) storeObservation'));
  assert(/continues = previous\.liveSince\.After\(death\)/.test(store.slice(0, 2_500)),
    'a live run can span a recorded serve death again, so a recovery can be vouched for by an observation '
    + 'taken before the fault');
});

// ---------------------------------------------------------------------------------------------------------
// The Go source: the same numbers, and the policy actually wired to readiness
// ---------------------------------------------------------------------------------------------------------

test('the daemon spells the same policy numbers this contract predeclares', () => {
  // THE CROSS-LANGUAGE PIN. The policy lives in Go and is predeclared here, and a number that exists twice is
  // a number that drifts. These are compiled in, so this is where they are held.
  const daemon = read(DAEMON_GO);
  const expect: Array<[string, number]> = [
    ['MountSampleMaxAge', PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_MAX_AGE_MS],
    ['MountBootstrapGrace', PROJECTIOND_MOUNT_HEALTH.MOUNT_BOOTSTRAP_GRACE_MS],
    ['MountFaultHold', PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS],
    ['MountRecoveryConfirm', PROJECTIOND_MOUNT_HEALTH.MOUNT_RECOVERY_CONFIRM_MS],
  ];
  for (const [name, value] of expect) {
    const found = new RegExp(`${name}\\s*=\\s*(\\d+)\\s*\\*\\s*time\\.Millisecond`).exec(daemon);
    if (found === null) throw new Error(`the daemon no longer declares ${name} where this pin can read it`);
    assertEq(Number(found[1]), value, `the daemon and the contract disagree about ${name}`);
  }
  // ...AND THEY ARE NOT FLAGS. An operator who could widen the fault hold could make a broken mount report
  // ready indefinitely, and the policy's whole value is that its bounds are a property of the product.
  const main = read(MAIN_GO);
  assert(!/flag\.(Duration|Int)\([^)]*(grace|fault-hold|recovery-confirm|mount-health)/i.test(main),
    'a policy bound became a flag, so a deployment can now decide what readiness means');
});

test('READINESS IS THE POLICY, and neither the old conjunction nor a bare observation', () => {
  const daemon = read(DAEMON_GO);
  // A REVERT WOULD SILENTLY UNDO THE WHOLE TRANCHE, and it would look like a simplification.
  assert(!/status\.Ready = status\.Mounted && d\.serveDeath\.Load\(\) == nil/.test(daemon),
    'readiness has reverted to the pre-Phase-5 conjunction, so the mount is no longer consulted');
  assert(/status\.Ready = verdict\.ready/.test(daemon),
    'readiness is no longer the decision of the predeclared policy');
  // ...AND THE POLICY IS STILL A PURE FUNCTION OF ONE MOMENT. A decision that read `mounted`, then the
  // sample, then the serve death would be a verdict about three different instants.
  assert(/func decideReadiness\(in readinessInputs\) readinessVerdict/.test(daemon),
    'the readiness decision is no longer a pure function of a gathered moment');
  // THE ENDPOINT STILL TAKES NO PROBE. Phase 5 made that property load-bearing: an inline probe would make an
  // appliance with a wedged mount unable to report that it has one.
  const status = daemon.slice(daemon.indexOf('func (d *Daemon) Status()'));
  assert(!/d\.SampleMount\(|d\.mountObserver\(/.test(status.slice(0, 3_000)),
    'the status path now takes an observation, so a wedged mount would hang the endpoint that reports it');
});

test('the bootstrap grace is anchored to the FIRST mount and forfeited by a death', () => {
  const daemon = read(DAEMON_GO);
  // A GRACE ANCHORED TO THE LATEST MOUNT WOULD HAND EVERY RECOVERY A FRESH WINDOW in which readiness need not
  // be observed at all — precisely how both of this product's worst failures stayed invisible.
  assert(/d\.mountedFirstAt\.CompareAndSwap\(0, time\.Now\(\)\.UnixNano\(\)\)/.test(daemon),
    'the first-mount stamp is no longer set once, so a remount can move the bootstrap grace');
  // ...AND `ClearServeDeath` MUST NOT UNDO THE RECORD. Retiring the current death is not the same statement
  // as its never having happened, and two policy decisions turn on the difference.
  const clear = daemon.slice(daemon.indexOf('func (d *Daemon) ClearServeDeath'));
  assert(!/lastServeDeathAt\.Store\(0\)/.test(clear.slice(0, 400)),
    'clearing a serve death now erases that one ever happened, so a recovery regains the grace it forfeited');
  assert(/d\.lastServeDeathAt\.Store\(now\.UnixNano\(\)\)/.test(daemon),
    'a serve death is no longer remembered past its own clearing');
});

test('THE LIVENESS SURFACE NEVER LEARNS TO TALK ABOUT THE MOUNT', () => {
  const daemon = read(DAEMON_GO);
  const liveness = /type Liveness struct \{([\s\S]*?)\n\}/.exec(daemon);
  if (liveness === null) throw new Error('the liveness document no longer has a type of its own');
  // THE WHOLE POINT IS WHAT IT DOES NOT CARRY. Once readiness can be false on a healthy process, a supervisor
  // needs one endpoint that cannot be made false by a broken mount.
  for (const forbidden of ['Ready', 'Mounted', 'MountObserved', 'Generation', 'ServeError']) {
    assert(!(liveness[1] as string).includes(forbidden),
      `the liveness document now carries ${forbidden}, so it is claiming something about the mount`);
  }
  // ...AND THE NONCLAIM IS WRITTEN DOWN RATHER THAN INFERRED FROM AN ABSENT FIELD.
  assert(/ClaimsMountUsable bool\s+`json:"claimsMountUsable"`/.test(daemon),
    'the liveness document no longer states its own nonclaim');
  assert(/ClaimsMountUsable: false/.test(daemon), 'the liveness nonclaim is no longer a constant false');
  // LOOPBACK ONLY ON THE ROUTE, not only on the bind, so the guarantee survives a different listener.
  const route = daemon.slice(daemon.indexOf('mux.HandleFunc("/healthz"'));
  assert(/requestIsLoopback\(r\)/.test(route.slice(0, 900)),
    'the liveness route no longer judges the caller, so it relies entirely on how it happens to be bound');
});

test('the Go policy test exists and drives the boundaries, rather than only the happy path', () => {
  // A POLICY WITH FOUR TIMERS IN IT IS NOT PROVED BY A HOST GATE THAT CAN PRODUCE EACH STATE ONCE. The
  // boundaries either side of each threshold are where an off-by-one in a policy actually lives, and they
  // are unreachable from a shell.
  assert(existsSync(READINESS_TEST_GO), 'the Go readiness policy test has been deleted');
  const suite = read(READINESS_TEST_GO);
  // THE CONSTANT NAMES ARE READ OUT OF THE DAEMON RATHER THAN GUESSED FROM THE CODES. A mechanical
  // code-to-identifier transform would be a second, private naming convention — and the first time a constant
  // was named for readability rather than for the transform, this pin would report a missing case that was
  // there all along.
  const daemon = read(DAEMON_GO);
  for (const reason of PROJECTIOND_MOUNT_HEALTH.READY_REASONS) {
    const declaration = new RegExp(`(ReadyReason\\w+)\\s*=\\s*"${reason}"`).exec(daemon);
    if (declaration === null) throw new Error(`the daemon no longer declares a constant for ${reason}`);
    assert(suite.includes(declaration[1] as string),
      `the Go policy test never reaches the reason ${reason}`);
  }
  // THE CONTROL. Without a case that reaches `ok`, every case in that table is satisfied by a policy that
  // answers not-ready unconditionally.
  assert(/is ready/.test(suite), 'the Go policy table has no case that reaches ready at all');
  // BOTH SIDES OF THE GRACE, which is the case that says the grace cannot carry a run.
  assert(/past the bootstrap grace/.test(suite) && /inside the bootstrap grace/.test(suite),
    'the Go policy table no longer drives both sides of the bootstrap grace');
});

// ---------------------------------------------------------------------------------------------------------
// The shipped healthcheck
// ---------------------------------------------------------------------------------------------------------

test('the image healthcheck is wired to READINESS and uses the predeclared numbers', () => {
  const dockerfile = read(DOCKERFILE);
  const directive = /HEALTHCHECK([^\n]*)\n\s*CMD ([^\n]*)/.exec(dockerfile);
  if (directive === null) throw new Error('the production image no longer carries a HEALTHCHECK');
  const [, options, command] = directive as unknown as [string, string, string];
  assert(command.includes('--healthcheck'),
    'the healthcheck no longer invokes the daemon binary\'s own readiness probe');
  assert(command.includes('projectiond'), 'the healthcheck does not run the shipped binary');
  // A DISTROLESS IMAGE HAS NO SHELL, so a shell-form healthcheck would be a healthcheck that never runs.
  assert(command.trim().startsWith('['),
    'the healthcheck is in shell form, and this image has no shell for it to run in');
  const numbers: Array<[RegExp, number, string]> = [
    [/--interval=(\d+)s/, PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_INTERVAL_S, 'interval'],
    [/--timeout=(\d+)s/, PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_TIMEOUT_S, 'timeout'],
    [/--start-period=(\d+)s/, PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_START_PERIOD_S, 'start period'],
    [/--retries=(\d+)/, PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_RETRIES, 'retries'],
  ];
  for (const [pattern, expected, what] of numbers) {
    const found = pattern.exec(options);
    if (found === null) throw new Error(`the healthcheck declares no ${what}`);
    assertEq(Number(found[1]), expected, `the image and the contract disagree about the healthcheck ${what}`);
  }
});

test('the healthcheck FAILS CLOSED and starts nothing', () => {
  const main = read(MAIN_GO);
  const probe = main.slice(main.indexOf('func runHealthcheck'));
  assert(probe.length > 0, 'the healthcheck probe is gone');
  // "I COULD NOT ASK" IS NOT "YES". A green light wired to nothing is worse than no light, and it is the
  // exact shape of failure this tranche exists to remove.
  for (const guard of ['cfg.StatusAddr == ""', 'response.StatusCode != http.StatusOK', '!report.Ready']) {
    assert(probe.includes(guard), `the healthcheck no longer fails closed on ${guard}`);
  }
  // IT MUST NOT CONSTRUCT A DAEMON. Doing so would create the probe-cache directory from a health probe,
  // every interval, as root.
  assert(!/daemon\.New\(/.test(probe.slice(0, 2_500)), 'the healthcheck now constructs a daemon');
  const order = main.indexOf('os.Exit(runHealthcheck(cfg))');
  assert(order > 0 && order < main.indexOf('d, err := daemon.New(cfg)'),
    'the healthcheck branch no longer comes before the daemon is constructed');
  // ...AND IT REPORTS THE CODE, WHICH IS THE ONE PLACE THE REASON REACHES AN OPERATOR VIA DOCKER.
  assert(/report\.ReadyReason/.test(probe), 'the healthcheck no longer reports the closed-set reason code');
});

test('THIS TRANCHE REPORTS AND DOES NOT ACT: no restart policy moved', () => {
  // Docker's `restart:` policies do not react to health status at all, so wiring health to an action would
  // have to be an explicit change somewhere. This pin is what makes "we changed no restart behaviour" a fact
  // about the files rather than a sentence in a document.
  const operator = read(join(repoRoot, 'docker-compose.projectiond.operator.yml'));
  assert(/restart: unless-stopped/.test(operator),
    'the operator harness restart policy changed in a tranche that promised not to touch it');
  assert(!/autoheal|willfarrell|restart_policy|on-unhealthy/i.test(operator),
    'something now acts on container health, which this tranche explicitly does not do');
});

// ---------------------------------------------------------------------------------------------------------
// The document restates nothing from memory
// ---------------------------------------------------------------------------------------------------------

test('the contract document and the module agree on every number', () => {
  const doc = read(DOC);
  const expected: Array<[string, number]> = [
    ['MOUNT_BOOTSTRAP_GRACE_MS', PROJECTIOND_MOUNT_HEALTH.MOUNT_BOOTSTRAP_GRACE_MS],
    ['MOUNT_FAULT_HOLD_MS', PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS],
    ['MOUNT_RECOVERY_CONFIRM_MS', PROJECTIOND_MOUNT_HEALTH.MOUNT_RECOVERY_CONFIRM_MS],
    ['LIVEZ_LATENCY_BUDGET_MS', PROJECTIOND_MOUNT_HEALTH.LIVEZ_LATENCY_BUDGET_MS],
    ['HEALTHCHECK_INTERVAL_S', PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_INTERVAL_S],
    ['HEALTHCHECK_TIMEOUT_S', PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_TIMEOUT_S],
    ['HEALTHCHECK_START_PERIOD_S', PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_START_PERIOD_S],
    ['HEALTHCHECK_RETRIES', PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_RETRIES],
    ['HEALTHCHECK_UNHEALTHY_BOUND_MS', PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_UNHEALTHY_BOUND_MS],
    ['ANTI_FLAP_TRANSIENT_MS', PROJECTIOND_MOUNT_HEALTH.ANTI_FLAP_TRANSIENT_MS],
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
  // A RUN RECORD MAY NOT BE OPTIMISTIC IN ADVANCE. Every 1/3 row either says a run did not happen, or names
  // the arms that did. Anything else is a row that reads as evidence without carrying any.
  const row = /^\| 1\/3 \|([^|]*)\|/m.exec(doc);
  if (row === null) throw new Error('the run record has no 1/3 row at all');
  const first = (row[1] as string).trim();
  assert(/NOT RUN|NOT ATTEMPTED|^—$/.test(first) || /MH1[\s\S]*MH12/.test(first),
    `the 1/3 row neither declines to claim a run nor names the arms of one: "${first}"`);
  if (/MH1[\s\S]*MH12/.test(first)) {
    assert(/\*\*Status: CLOSED\.\*\*/.test(doc), 'runs are recorded but the status still says otherwise');
    assert(/zero skips/.test(doc), 'the run record does not say whether anything was skipped');
  }
  // THE NONCLAIMS ARE LOAD-BEARING and are what keeps a tranche this size honest about its edges.
  for (const phrase of ['closes only itself', 'A policy is not a recovery',
    'It reports; it does not act', 'not a load test', '`mounted` still means what it meant']) {
    assert(doc.includes(phrase), `the nonclaim "${phrase}" has been dropped from the document`);
  }
  assert(/G7–G13, G18 or G22/.test(doc), 'the document no longer says which G-numbers it does not close');
});

test('PHASE 4 IS SUPERSEDED IN THE OPEN, and none of its measurements is withdrawn', () => {
  // A CLOSED PHASE WHOSE DOCUMENT NOW CONTRADICTS THE PRODUCT IS WORSE THAN ONE THAT SAYS SO. Phase 4 §5
  // named this exact change and deferred it; the supersession has to point at that sentence rather than
  // quietly editing around it.
  const phase4 = read(join(repoRoot, 'docs', 'PROJECTION_PHASE_4_MOUNT_TRUTH.md'));
  assert(/SUPERSEDED BY PHASE 5/.test(phase4),
    'Phase 4 no longer records that Phase 5 took the decision its §5 deferred');
  assert(/Nothing measured in this document is withdrawn/.test(phase4),
    'the supersession no longer says that Phase 4 measurements still stand');
  // ...AND ITS OWN RUN RECORD IS UNTOUCHED.
  assert(/18 arm verdicts, 18 pass, 0 fail, 0 skip/.test(phase4),
    'Phase 4 measured evidence has been edited by a later tranche');
  assert(([...PROJECTIOND_MOUNT_OBSERVATION.DOES_NOT_CHANGE] as string[]).join(',') === 'mounted',
    'the additive rule no longer names exactly the one field Phase 5 left it protecting');
});

test('PHASE 3 IS OUT OF SCOPE BECAUSE OF WHAT ITS GATE DOES, not because of what this document says', () => {
  // THE AUDIT IS PINNED SO IT STAYS TRUE RATHER THAN STAYING WRITTEN DOWN. Phase 5 changes readiness
  // semantics, so the question "does Phase 3 consume them?" decides whether a real-provider re-run is owed.
  // Its gate defines a /readyz reader and never calls it; its recovery clock is a sibling reading one BYTE
  // through the mount, chosen deliberately over /readyz. If either of those ever changes, this pin fails and
  // the scope decision has to be taken again.
  const gate = shellCodeOf(read(RELIABILITY_GATE));
  const calls = (gate.match(/daemon_status\b/g) ?? []).length;
  assertEq(calls, 1,
    'the reliability-loop gate now uses daemon_status, so Phase 3 consumes the readiness semantics this '
    + 'tranche changed and the real-provider closure is owed');
  assert(/await_readable/.test(gate) && /RECOVERY_MS=\$\(\( \$\(date \+%s%3N\) - started \)\)/.test(gate),
    'the reliability-loop recovery clock is no longer a sibling byte read, so it may now key on readiness');
});

// ---------------------------------------------------------------------------------------------------------
// The gate, once it exists
// ---------------------------------------------------------------------------------------------------------

test('the gate is provider-free BY CONSTRUCTION, not by intention', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const gate = shellCodeOf(read(GATE));
  for (const forbidden of ['torbox-credential', 'gate-secret', 'objects.json', 'endpoint.json',
    'PROJECTION_TORBOX_INPUT_DIR']) {
    assert(!gate.includes(forbidden),
      `the gate references ${forbidden}, so it is not provider-free by construction`);
  }
  // BOTH daemons must be configured with no endpoint at all — the blocker is a projectiond too.
  assertEq((gate.match(/"endpoints": \[\]/g) ?? []).length, 2,
    'one of the two daemon configurations no longer declares an empty endpoint list');
});

test('the gate binds its consumer BEFORE the first mount, and reads BYTES', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const gate = shellCodeOf(read(GATE));
  // §11 of the Phase 0 contract: a consumer that attaches after the daemon has mounted cannot follow a
  // remount, and no daemon behaviour can make it. MH9 is about a consumer surviving a recovery.
  assert(gate.includes('rslave'), 'the consumer does not bind rslave');
  // ...AND IT READS BYTES. A dead FUSE mount answers stat from a warm attribute cache while every open
  // returns ENOTCONN, so `test -f` would pass over the exact state this gate exists to detect.
  assert(/sha256sum/.test(gate),
    'the consumer check is metadata, which a corpse answers from a warm attribute cache');
  assert(!/test -f .*ENTRY_PATH/.test(gate), 'a byte check was replaced by a metadata one');
});

test('the gate spells none of the thresholds and reads them from the module instead', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const gate = read(GATE);
  const forbidden = new Set<number>();
  for (const value of [...Object.values(PROJECTIOND_MOUNT_OBSERVATION),
    ...Object.values(PROJECTIOND_MOUNT_HEALTH)]) {
    if (typeof value === 'number' && value >= 1_000) forbidden.add(value);
  }
  for (const value of forbidden) {
    const literal = new RegExp(`(^|[^0-9_.])${value}([^0-9_]|$)`, 'm');
    // THE LINE NUMBERS ARE THE FILE'S, WHICH MEANS INDEXING BEFORE FILTERING. A diagnostic that sends the
    // reader to the wrong line costs more than no diagnostic at all.
    const offending = gate.split('\n')
      .map((line, index) => [index + 1, line] as const)
      // A COMMENT MAY SAY A NUMBER; ONLY EXECUTABLE TEXT MAY NOT. The rule is about drift between the shell
      // and the module, and prose is where the derivation gets explained.
      .filter(([, line]) => !/^\s*#/.test(line))
      // TWO FORMS ARE NOT RESTATEMENTS AND ARE NAMED RATHER THAN WAVED THROUGH:
      //   `1000:1000`  a uid:gid pair. The consumer runs unprivileged and its uid is not a budget.
      //   `/ 1000`     milliseconds to seconds. Arithmetic ON a threshold, not a second copy OF one — the
      //                gate still has to have read the threshold to divide it.
      // Neither can hide a real restatement: a threshold used as a threshold appears as a bare comparison
      // operand, which neither pattern removes.
      .map(([n, line]) => [n, line.replace(/\b\d+:\d+\b/g, '').replace(/\/\s*1000\b/g, '')] as const)
      .filter(([, line]) => literal.test(line));
    assertEq(offending.length, 0,
      `the gate spells the threshold ${value} literally at line(s) ${offending.map(([n]) => n).join(', ')}`);
  }
});

test('THE GATE COMPARES AGAINST REASON CODES IT WAS GIVEN, never ones it typed', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const gate = shellCodeOf(read(GATE));
  // AN ARM COMPARING AGAINST A MISTYPED LITERAL IS AN ARM THAT CAN NEVER FAIL, and a mistyped reason code
  // reads exactly like a correct one. So the codes travel from the module the same way the numbers do.
  for (const reason of PROJECTIOND_MOUNT_HEALTH.READY_REASONS) {
    assert(!gate.includes(`"${reason}"`) && !gate.includes(`'${reason}'`),
      `the gate spells the reason code ${reason} literally instead of reading it from the module`);
  }
  // ...AND THE FOUR ARMS THAT TURN ON A SPECIFIC CODE ACTUALLY NAME ONE.
  for (const variable of ['MH_REASON_OK', 'MH_REASON_SERVE_LOOP_DEAD', 'MH_REASON_MOUNT_OBSERVED_NOT_LIVE',
    'MH_REASON_MOUNT_OBSERVATION_STALE']) {
    assert(gate.includes(`$${variable}`), `the gate no longer asserts against ${variable}`);
  }
});

test('the gate holds all twelve predeclared ids and cannot pass without its own control', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const executable = shellCodeOf(read(GATE));
  for (const id of ['MH1', 'MH2', 'MH3', 'MH4', 'MH5', 'MH6', 'MH7', 'MH8', 'MH9', 'MH10', 'MH11', 'MH12']) {
    assert(executable.includes(id), `the gate no longer records ${id}`);
  }
  // MH1 IS THE CONTROL AND IT IS NOT OPTIONAL. Without a healthy reading to compare against, every arm below
  // is satisfied by a daemon that answers not-ready unconditionally.
  assert(/MH1_CODE" = "200"/.test(executable),
    'MH1 no longer asserts a ready answer, so the later arms have nothing to be different from');
  assert(/MH1_HEALTH" = "healthy"/.test(executable),
    'MH1 no longer asserts a healthy container, so MH7 has no transition to be a transition from');
});

test('MH6 CANNOT PASS ON A FAULT THAT NEVER HAPPENED, which is the arm most at risk of it', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const executable = shellCodeOf(read(GATE));
  const mh6 = executable.slice(executable.indexOf('MH6_TAG='), executable.indexOf('MH2_TAG='));
  assert(mh6.length > 0, 'the MH6 block is gone');
  // "READINESS STAYED TRUE" IS SATISFIED BY A FAULT THE DAEMON NEVER SAW. Without the control half, this arm
  // would pass most reliably when the injection was broken — the exact shape this repository keeps finding.
  assert(/MH6_SAW_FAULT=1/.test(mh6) && /MH6_SAW_FAULT" -eq 1/.test(mh6),
    'MH6 no longer requires a non-live observation to have actually been reported');
  assert(/MH6_LOST_READY" -eq 0/.test(mh6), 'MH6 no longer requires readiness to have held');
  // AND ITS TARGET IS GUARDED TO THIS RUN. This gate mounts and unmounts on a real host.
  assert(/case "\$DAEMON_CONTAINER" in[\s\S]{0,200}projection-mount-health-daemon-\$\$\)/.test(mh6),
    'MH6 does not verify the daemon container belongs to this run before touching its namespace');
  assert(/MH6_TOP_BEFORE" = "fuse\.projectiond"/.test(mh6),
    'MH6 stacks without first proving the top of the stack is ours');
  assert(/MH6_TOP_NOW" = "tmpfs"/.test(mh6),
    'MH6 unmounts without first proving the top is the tmpfs it stacked');
});

test('MH4 freezes a mount it proved landed, and releases it before removing it', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const executable = shellCodeOf(read(GATE));
  const mh4 = executable.slice(executable.indexOf('MH4_DEATHS_BEFORE='), executable.indexOf('MH3_MOUNTS='));
  assert(mh4.length > 0, 'the MH4 block is gone');
  // FREEZING WITHOUT PROVING THE BLOCKER LANDED WOULD FREEZE NOTHING, and the arm would then be measuring a
  // mount that was never blocked. Two guards, and both are required.
  assert(/MH4_LANDED" -eq 1/.test(mh4), 'MH4 freezes without proving the blocking mount landed on top');
  assert(/daemon_mounts\)" = "2"/.test(mh4), 'MH4 no longer counts our own mounts before freezing');
  assert(/docker pause "\$BLOCKER_CONTAINER"/.test(mh4), 'MH4 no longer freezes the blocking server');
  // A FROZEN CONTAINER CANNOT PROCESS A SIGNAL. Stopping one while paused waits out the whole timeout, kills
  // it, and leaves its FUSE mount on the host — the leak MH12 exists to catch.
  const unpause = mh4.indexOf('docker unpause');
  const stop = mh4.indexOf('docker stop -t 30 "$BLOCKER_CONTAINER"');
  assert(unpause > 0 && stop > unpause,
    'MH4 stops the blocker before releasing it, which leaves its mount behind');
  // ...AND THE BELIEF MUST BE PROVEN UNTOUCHED. A blocked probe that had also killed the serve loop would be
  // measuring rule 3, not rule 5.
  assert(/MH4_DEATHS_AFTER" = "\$MH4_DEATHS_BEFORE"/.test(mh4),
    'MH4 does not prove the serve loop never noticed the block');
  assert(/MH4_MOUNTED" = "true"/.test(mh4), 'MH4 does not prove the daemon still believed it was mounted');
});

test('MH8 measures the FIRST ready reading, not the last', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const executable = shellCodeOf(read(GATE));
  const mh8 = executable.slice(executable.indexOf('MH8_FIRST_OBSERVED='));
  // A LATER READING WOULD ALWAYS SATISFY THE CONDITION. `--auto-remount` sets `mounted` true and clears the
  // serve death well before the mount is observed; if readiness returned on those alone, only the FIRST ready
  // reading would show it — which is exactly Phase 2's worst defect.
  assert(/MH8_FIRST_RUN" -ge "\$MH_MOUNT_RECOVERY_CONFIRM_MS"/.test(mh8),
    'MH8 no longer requires a confirmed live run at the moment readiness returned');
  assert(/MH8_FIRST_OBSERVED" = "\$MH_STATE_LIVE"/.test(mh8),
    'MH8 no longer requires the mount to have been observed live when readiness returned');
  assert(/MH8_FIRST_GRACE" = "false"/.test(mh8),
    'MH8 no longer proves the recovery was not granted by a grace the death should have forfeited');
  // AND IT MUST HAVE SEEN AN OUTAGE AT ALL. The first real run scored the ABSENCE of an outage as a
  // successful recovery from one: the death and remount passed between two samples, readiness never dropped,
  // and the arm reported a "confirmed live run" that had begun 72 seconds before the abort.
  assert(/MH8_SAW_OUTAGE" -eq 1/.test(mh8),
    'MH8 can conclude a recovery without ever having observed readiness drop, which is how it passed '
    + 'vacuously on its first real run');
});

test('the gate takes its own port and no other gate has it', () => {
  if (!gateExists()) { skipBlock(GATE_ABSENT); return; }
  const compose = read(COMPOSE);
  assert(/PROJECTION_MOUNT_HEALTH_GATE_PG_PORT:-5610/.test(compose), 'the gate does not take its own port');
  // THIS GATE HAS TO BE STARTABLE BESIDE EVERY OTHER ONE. A shared port is how one run lends another its
  // state, and "it passed" stops meaning "it passed from nothing".
  //
  // THE ASSERTION IS ABOUT THIS GATE'S PORT AND DELIBERATELY NOT ABOUT EVERY PAIR. Two pre-existing pairs
  // elsewhere in `deploy/` already share a number, and they were shared before this tranche existed. Widening
  // this pin to the whole set would make a Phase 5 suite fail for a Phase 1 and Phase 2 fact, and repairing
  // those here would be an unrelated change to two closed gates' infrastructure. It is recorded rather than
  // silently narrowed: the general property is NOT asserted here, and nothing here claims it holds.
  const owners: string[] = [];
  for (const file of readdirSync(repoRoot).filter((name) => /^docker-compose\..*\.yml$/.test(name))) {
    if (/PG_PORT:-5610\}/.test(read(join(repoRoot, file)))) owners.push(file);
  }
  assertEq(owners.length, 1, `port 5610 is claimed by more than one gate: ${owners.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------------------

console.log(`\nProjection Phase 5 — the observation becomes operationally authoritative: `
  + `${passed} passed, ${failed} failed`
  + (skippedBlocks.length > 0 ? `, ${skippedBlocks.length} block(s) SKIPPED and asserting nothing` : ''));
for (const what of skippedBlocks) console.log(`  skipped: ${what}`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`  FAILED: ${name}: ${String(error)}`);
  process.exit(1);
}
