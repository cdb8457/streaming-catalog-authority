import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROJECTIOND_MOUNT_HEALTH,
  PROJECTIOND_MOUNT_OBSERVATION,
  PROJECTIOND_MOUNT_RECOVERY,
  RECOVERY_NEVER_ACTS_ON_A_FAULT_READINESS_DID_NOT_BELIEVE,
  RECOVERY_ATTEMPTS_CANNOT_OVERLAP,
  RECOVERY_CANNOT_LOOP_FOREVER,
  RECOVERY_REFUND_REQUIRES_A_FRESH_OBSERVATION,
} from '../src/core/projection/runtime-contract.js';

// Projection Phase 6 — bounded automatic recovery and the deployable alpha, offline.
//
// WHAT THIS SUITE IS FOR. The tranche's claim is that the daemon now ACTS on a bounded set of mount faults
// and REFUSES everything else. So the things most worth pinning are (a) the bounds and their derivations, in
// one place, agreeing across the contract, the document, the Go source and the gate; (b) the classification,
// which is the part of a state machine that silently widens; (c) that nothing published is outside a closed
// set; and (d) that the packaging cannot silently acquire a default that points at somebody else's data.
//
// THE DEEP BEHAVIOURAL PROOF IS IN GO, NOT HERE. `projectiond/internal/daemon/recovery_test.go` drives the
// machine with a fake clock across both sides of every bound, and the durable ledger across a simulated
// restart. This file is what stops the numbers, the codes and the shapes drifting apart between languages.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const DOC = join(repoRoot, 'docs', 'PROJECTION_PHASE_6_DEPLOYABLE_ALPHA.md');
const ROADMAP = join(repoRoot, 'docs', 'PROJECTION_ROADMAP.md');
const RECOVERY_GO = join(repoRoot, 'projectiond', 'internal', 'daemon', 'recovery.go');
const RECOVERY_TEST_GO = join(repoRoot, 'projectiond', 'internal', 'daemon', 'recovery_test.go');
const DAEMON_GO = join(repoRoot, 'projectiond', 'internal', 'daemon', 'daemon.go');
const MAIN_GO = join(repoRoot, 'projectiond', 'cmd', 'projectiond', 'main.go');
const GATE = join(repoRoot, 'deploy', 'projection-recovery-gate.sh');
const GATE_THREE = join(repoRoot, 'deploy', 'projection-recovery-gate-three.sh');
const COMPOSE = join(repoRoot, 'docker-compose.projection-recovery.yml');
const ALPHA_COMPOSE = join(repoRoot, 'docker-compose.projection-alpha.yml');
const ALPHA_SCRIPT = join(repoRoot, 'deploy', 'projection-alpha.sh');
const ALPHA_ENV = join(repoRoot, 'deploy', 'projectiond-alpha.env.example');
const RECOVERY_CLI = join(repoRoot, 'src', 'ops', 'projection-recovery-cli.ts');

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
class Skipped extends Error {}
function skipBlock(what: string): never {
  throw new Skipped(what);
}

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

console.log('\nProjection Phase 6 — bounded automatic recovery and the deployable alpha\n');

// ---------------------------------------------------------------------------------------------------------
// The bounds, and the derivations that make them mean anything
// ---------------------------------------------------------------------------------------------------------

test('the bounds are what this tranche predeclared, and the derivations still derive', () => {
  assertEq(PROJECTIOND_MOUNT_RECOVERY.RECOVERY_MAX_ATTEMPTS, 3, 'the attempt budget');
  assertEq(PROJECTIOND_MOUNT_RECOVERY.RECOVERY_ATTEMPT_DEADLINE_MS, 20_000, 'the attempt deadline');

  // DERIVED MEANS DERIVED. A number that used to be derived and is now merely equal to its old value is a
  // number that will not move when its input does.
  assertEq(PROJECTIOND_MOUNT_RECOVERY.RECOVERY_TICK_MS,
    PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_INTERVAL_MS,
    'the tick is no longer one sample interval, so it is polling faster than the verdict can change');
  assertEq(PROJECTIOND_MOUNT_RECOVERY.RECOVERY_SUSTAIN_MS,
    PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS,
    'the sustain window is no longer one whole fault hold, so it is no longer the SECOND hold');
  assertEq(PROJECTIOND_MOUNT_RECOVERY.RECOVERY_COOLDOWN_MS,
    PROJECTIOND_MOUNT_RECOVERY.RECOVERY_ATTEMPT_DEADLINE_MS,
    'the cooldown no longer outlasts a whole attempt deadline, so an abandoned attempt could still be '
    + 'running when the next one starts');
  assertEq(PROJECTIOND_MOUNT_RECOVERY.RECOVERY_CONFIRM_MS,
    PROJECTIOND_MOUNT_HEALTH.MOUNT_RECOVERY_CONFIRM_MS + PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_MAX_AGE_MS,
    'the refund window is no longer the recovery confirmation plus a whole worst-case sampling window');
});

test('the four derived relations hold, and each of them is a check rather than a comment', () => {
  assert(RECOVERY_NEVER_ACTS_ON_A_FAULT_READINESS_DID_NOT_BELIEVE,
    'a recovery could fire on a fault readiness had not already believed');
  assert(RECOVERY_ATTEMPTS_CANNOT_OVERLAP, 'two attempts could overlap in wall-clock');
  assert(RECOVERY_CANNOT_LOOP_FOREVER, 'the budget is no longer finite, durable and cleared only by a human');
  assert(RECOVERY_REFUND_REQUIRES_A_FRESH_OBSERVATION,
    'the budget could be refunded by the same observation that granted readiness');
});

test('the time-to-act is the SUM of both holds, which is the property the tranche is built on', () => {
  // TWELVE SECONDS OF A FAULT NOBODY ELSE FIXED, and it is supposed to be. An appliance that remounts faster
  // than that is one that remounts on transients, which is the failure this tranche exists to avoid — not
  // the one it exists to fix.
  const timeToAct = PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_SUSTAIN_MS;
  assertEq(timeToAct, 12_000, 'the time-to-act');
  assert(timeToAct > PROJECTIOND_MOUNT_HEALTH.ANTI_FLAP_TRANSIENT_MS * 2,
    'a fault twice as long as the anti-flap transient could now trigger a recovery');
});

test('a recovery cannot be entitled to act before a container healthcheck has even reported', () => {
  // THE TWO POLICIES MUST NOT DISAGREE ABOUT WHAT IS BROKEN. Docker's own retry budget outlasts the daemon's
  // fault hold by contract (Phase 5's DAEMON_DECIDES_UNHEALTHY_NOT_DOCKER); the recovery loop waits a whole
  // further hold on top. So an operator watching container health sees `unhealthy` in the same window the
  // daemon is deciding to act, rather than after it has already acted twice.
  assert(PROJECTIOND_MOUNT_RECOVERY.RECOVERY_SUSTAIN_MS > 0
    && PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_SUSTAIN_MS
       < PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_UNHEALTHY_BOUND_MS,
    'a recovery could be entitled to act after the healthcheck was already allowed to report unhealthy, so '
    + 'an operator could see a container recover before it was ever reported broken');
});

// ---------------------------------------------------------------------------------------------------------
// The Go source agrees, in both directions
// ---------------------------------------------------------------------------------------------------------

test('every bound in the contract is the same number in the Go source', () => {
  const go = read(RECOVERY_GO);
  const expect: ReadonlyArray<readonly [string, number]> = [
    ['RecoveryTick', PROJECTIOND_MOUNT_RECOVERY.RECOVERY_TICK_MS],
    ['RecoverySustain', PROJECTIOND_MOUNT_RECOVERY.RECOVERY_SUSTAIN_MS],
    ['RecoveryAttemptDeadline', PROJECTIOND_MOUNT_RECOVERY.RECOVERY_ATTEMPT_DEADLINE_MS],
    ['RecoveryCooldown', PROJECTIOND_MOUNT_RECOVERY.RECOVERY_COOLDOWN_MS],
    ['RecoveryConfirm', PROJECTIOND_MOUNT_RECOVERY.RECOVERY_CONFIRM_MS],
  ];
  for (const [name, value] of expect) {
    const pattern = new RegExp(`${name}\\s*=\\s*${value}\\s*\\*\\s*time\\.Millisecond`);
    assert(pattern.test(go), `${name} in recovery.go is not ${value}ms`);
  }
  assert(new RegExp(`RecoveryMaxAttempts\\s*=\\s*${PROJECTIOND_MOUNT_RECOVERY.RECOVERY_MAX_ATTEMPTS}\\b`)
    .test(go), 'RecoveryMaxAttempts in recovery.go disagrees with the contract');
  assert(go.includes(`RecoveryLedgerFilename = "${PROJECTIOND_MOUNT_RECOVERY.LEDGER_FILENAME}"`),
    'the ledger filename in recovery.go disagrees with the contract');
});

test('every decision code, state and remediation in the contract exists in the Go source', () => {
  const go = read(RECOVERY_GO);
  for (const code of PROJECTIOND_MOUNT_RECOVERY.DECISION_CODES) {
    assert(go.includes(`"${code}"`), `the decision code ${code} is in the contract and not in recovery.go`);
  }
  for (const state of PROJECTIOND_MOUNT_RECOVERY.STATES) {
    assert(go.includes(`"${state}"`), `the state ${state} is in the contract and not in recovery.go`);
  }
  for (const remediation of PROJECTIOND_MOUNT_RECOVERY.REMEDIATIONS) {
    assert(go.includes(`"${remediation}"`),
      `the remediation ${remediation} is in the contract and not in recovery.go`);
  }
  for (const verdict of PROJECTIOND_MOUNT_RECOVERY.UNDERLAY_VERDICTS) {
    assert(go.includes(`"${verdict}"`),
      `the underlay verdict ${verdict} is in the contract and not in recovery.go`);
  }
});

test('...and in the OTHER direction: the Go source publishes no code the contract does not name', () => {
  // THIS IS THE HALF THAT ACTUALLY CATCHES SOMETHING. A code added to Go and forgotten in the contract is a
  // code an operator's monitoring rule cannot know about, and a one-directional pin would never see it.
  const go = read(RECOVERY_GO);
  const known = new Set<string>([
    ...PROJECTIOND_MOUNT_RECOVERY.DECISION_CODES,
    ...PROJECTIOND_MOUNT_RECOVERY.STATES,
    ...PROJECTIOND_MOUNT_RECOVERY.REMEDIATIONS,
    // The attempt outcomes, which are a separate small closed set published as `recoveryLastOutcome`.
    'none', 'succeeded', 'failed', 'refused',
  ]);
  const declared = go.matchAll(/^\tRecover(?:y)?[A-Za-z]+\s+=\s+"([a-z][a-z0-9-]*)"/gm);
  for (const match of declared) {
    const value = match[1] ?? '';
    assert(known.has(value),
      `recovery.go declares "${value}", which is in no closed set the contract publishes`);
  }
  // ...AND THE SAME SWEEP OVER THE UNDERLAY VERDICTS, WHICH ARE DECLARED UNDER THEIR OWN PREFIX. A verdict
  // added to Go and forgotten in the contract is a verdict an operator's monitoring rule cannot know about,
  // and — far worse here — a fourth value nobody has decided whether to trust.
  const verdicts = go.matchAll(/^\tUnderlay[A-Za-z]+\s+=\s+"([a-z][a-z0-9-]*)"/gm);
  const namedVerdicts = new Set<string>(PROJECTIOND_MOUNT_RECOVERY.UNDERLAY_VERDICTS);
  let verdictCount = 0;
  for (const match of verdicts) {
    verdictCount += 1;
    const value = match[1] ?? '';
    assert(namedVerdicts.has(value),
      `recovery.go declares the underlay verdict "${value}", which the contract does not name`);
  }
  assertEq(verdictCount, PROJECTIOND_MOUNT_RECOVERY.UNDERLAY_VERDICTS.length,
    'recovery.go declares a different number of underlay verdicts than the contract names');
});

// ---------------------------------------------------------------------------------------------------------
// PROJECTION PHASE 7 §8.4 — the expected underlay, and the containment that keeps it from being a licence
// ---------------------------------------------------------------------------------------------------------

test('EXACTLY ONE underlay verdict is actionable, and the foreign row is the only place it is read', () => {
  const go = read(RECOVERY_GO);
  const classify = go.slice(go.indexOf('func classifyRecovery'), go.indexOf('func decideRecovery'));
  assert(classify.length > 200, 'classifyRecovery could not be located in recovery.go');
  // THE ARGUMENT IS THERE AT ALL. Without it the whole decision is the Phase 6 table again.
  assert(/func classifyRecovery\(readyReason, observed, underlay string\)/.test(go),
    'classifyRecovery no longer takes the underlay verdict, so the foreign row cannot tell the operator\'s '
    + 'own pre-existing bind from anything else');
  // AND IT IS READ EXACTLY ONCE, INSIDE THE FOREIGN CASE. A second reader is a second licence, so the count of
  // places the argument is USED — as opposed to declared in the signature — is itself the pin.
  const uses = (classify.match(/\bunderlay ==/g) ?? []).length + (classify.match(/\bunderlay !=/g) ?? []).length;
  assertEq(uses, 1, 'the underlay verdict is read in more than one place in classifyRecovery');
  const foreign = classify.slice(classify.indexOf('case "foreign":'));
  const foreignEnd = foreign.indexOf('default:');
  const foreignBody = foreignEnd > 0 ? foreign.slice(0, foreignEnd) : foreign;
  assert(/if underlay == UnderlayExposed \{[\s\S]*?return RecoverActMountUnderlay, true, false/.test(foreignBody),
    'the foreign row no longer admits the proved expected underlay, so an external umount of the projected '
    + 'path is unrepairable again');
  assert(/return RecoveryRefuseForeignMount, false, true/.test(foreignBody),
    'the foreign row no longer refuses everything else — this is the defect --auto-remount shipped once');
  // THE OTHER THREE VERDICTS APPEAR NOWHERE IN THE CLASSIFICATION AT ALL, which is the strongest form this
  // containment can take in a source pin: they cannot be conditions if they are not mentioned.
  for (const forbidden of ['UnderlayCovered', 'UnderlayChanged', 'UnderlayUnknown']) {
    assert(!classify.includes(forbidden),
      `classifyRecovery mentions ${forbidden}; only the one admitting verdict may ever be a condition`);
  }
  // ...AND THE ADMITTING COMPARISON IS AN EQUALITY AGAINST THE ONE CONSTANT, not an inequality that widens as
  // the closed set grows. `underlay != UnderlayUnknown` would admit two verdicts the day a fifth is added.
  assert(!/if underlay != /.test(classify),
    'the underlay condition is written as an inequality, which admits every verdict but one rather than one');
});

test('the underlay fingerprint is taken BEFORE the first mount and is never re-taken', () => {
  const main = read(MAIN_GO);
  const capture = main.indexOf('fusefs.MountStackAt(cfg.MountPoint)');
  const firstMount = main.indexOf('mount, err := fusefs.Mount(d, cfg.MountPoint');
  assert(capture > 0, 'the mount point is no longer fingerprinted at startup');
  assert(firstMount > 0, 'the first mount could not be located in main');
  assert(capture < firstMount,
    'THE FINGERPRINT IS TAKEN AFTER THE FIRST MOUNT, so it would record this daemon\'s own mount as part of '
    + 'the operator\'s pre-existing underlay — which is the whole property inverted');
  // The verifier closes over the baseline; nothing in it may refresh the baseline.
  const verifier = main.slice(main.indexOf('func newUnderlayVerifier'));
  const verifierBody = verifier.slice(0, verifier.indexOf('\n// planRemountCleanup'));
  assertEq((verifierBody.match(/MountStackAt/g) ?? []).length, 1,
    'the underlay verifier reads the mount stack more than once, so it may be refreshing its own baseline — '
    + 'a verifier that re-measures its baseline agrees with itself for ever');
  assert(!verifierBody.includes('startupKnown = ') && !verifierBody.includes('startup = '),
    'the underlay verifier reassigns its own baseline');
});

test('a fingerprint that disagrees with the startup count is discarded rather than trusted', () => {
  const main = read(MAIN_GO);
  assert(/len\(startupStack\) != mountsAtStartup/.test(main),
    'the two startup measurements are no longer cross-checked, so two reads that disagreed would both be '
    + 'spent as one measurement neither of them made');
  assert(/startupStackKnown = false/.test(main),
    'a disagreement between the two startup measurements no longer discards the fingerprint');
});

test('the underlay verifier reads the mount table and takes no statfs, so it cannot be made to block', () => {
  const main = read(MAIN_GO);
  const verifier = main.slice(main.indexOf('func newUnderlayVerifier'));
  const body = verifier.slice(0, verifier.indexOf('\n// planRemountCleanup'));
  for (const blocking of ['ObserveMountpoint', 'ProbeMountpoint', 'Statfs', 'statfs(']) {
    assert(!body.includes(blocking),
      `the underlay verifier calls ${blocking}, which reaches the FUSE connection — the verdict is taken on `
      + 'the recovery loop\'s own tick and on the mount owner\'s path, and neither may park in an '
      + 'uninterruptible syscall');
  }
});

test('the verifier logs the FIELD that changed and never the value', () => {
  const main = read(MAIN_GO);
  const verifier = main.slice(main.indexOf('func newUnderlayVerifier'));
  const body = verifier.slice(0, verifier.indexOf('\n// planRemountCleanup'));
  assert(body.includes('changedField'), 'the verifier no longer says which evidence failed');
  // A LOG LINE MAY CARRY THE OPERATOR'S OWN MOUNT POINT AND THE DIGEST, AND NOTHING ELSE. Sources and subtree
  // roots are paths into the operator's storage and are exactly what this daemon's log may not print.
  for (const leak of ['.Source', '.Root', '.Device', '%+v', 'current[', 'startup[']) {
    assert(!body.includes(leak),
      `the underlay verifier's log line reaches for ${leak}, which puts a mount identity value in the log`);
  }
});

test('the classification is exhaustive on every Phase 5 readiness reason', () => {
  const go = read(RECOVERY_GO);
  const classify = go.slice(go.indexOf('func classifyRecovery'), go.indexOf('func decideRecovery'));
  assert(classify.length > 200, 'classifyRecovery could not be located in recovery.go');
  for (const reason of PROJECTIOND_MOUNT_HEALTH.READY_REASONS) {
    const constant = {
      'ok': 'ReadyReasonOK',
      'no-generation-admitted': 'ReadyReasonNoGeneration',
      'serve-loop-dead': 'ReadyReasonServeLoopDead',
      'not-mounted': 'ReadyReasonNotMounted',
      'mount-observed-not-live': 'ReadyReasonMountNotLive',
      'mount-observation-stale': 'ReadyReasonObservationStale',
      'mount-observation-unavailable': 'ReadyReasonObservationUnavailable',
      'mount-recovering': 'ReadyReasonMountRecovering',
    }[reason];
    assert(typeof constant === 'string' && classify.includes(`case ${constant}:`),
      `classifyRecovery has no case for ${reason}, so it would fall through to the default`);
  }
  // ...AND THE DEFAULT REFUSES. An unrecognised state is not a licence to act on it.
  assert(/default:\s*\n\s*return RecoveryRefuseUnknownState, false, true/.test(classify),
    'the default branch of classifyRecovery does not refuse');
});

test('a serve-loop death is DECLINED by the recovery loop, which is the single most load-bearing row', () => {
  const go = read(RECOVERY_GO);
  const classify = go.slice(go.indexOf('func classifyRecovery'), go.indexOf('func decideRecovery'));
  assert(/case ReadyReasonServeLoopDead:[\s\S]*?return RecoveryNoActionServeOwns, false, false/.test(classify),
    'the recovery loop no longer declines a serve-loop death, so one fault has two supervisors');
});

test('a FOREIGN observation is refused and neither of the two actionable ones is', () => {
  const go = read(RECOVERY_GO);
  const classify = go.slice(go.indexOf('func classifyRecovery'), go.indexOf('func decideRecovery'));
  assert(/case "foreign":[\s\S]*?return RecoveryRefuseForeignMount, false, true/.test(classify),
    'a foreign mount is no longer refused — this is the defect --auto-remount shipped once already');
  assert(/case "stale-projectiond":\s*\n\s*return RecoverActStaleMount, true, false/.test(classify),
    'our own stale mount is no longer actionable');
  assert(/case "empty":\s*\n\s*return RecoverActMountEmpty, true, false/.test(classify),
    'an empty mount point is no longer actionable');
});

test('the ledger is durable, atomic, and an unreadable one locks out rather than starting fresh', () => {
  const go = read(RECOVERY_GO);
  assert(PROJECTIOND_MOUNT_RECOVERY.LEDGER_IS_CRASH_PERSISTENT,
    'the contract no longer requires the ledger to survive a restart');
  assert(go.includes('os.Rename(temp, path)'),
    'the ledger is no longer written atomically, so a crash mid-write could turn a recoverable appliance '
    + 'into one that needs a human');
  assert(/errors\.Is\(err, os\.ErrNotExist\)[\s\S]{0,200}RecoveryLedger\{Version: recoveryLedgerVersion\}/
    .test(go), 'an ABSENT ledger is no longer treated as a fresh budget');
  assert(go.includes('LockoutCode: RecoveryLedgerUnreadable'),
    'an UNREADABLE ledger no longer locks out, so a supervisor that cannot see its budget would spend it');
  assert(go.includes('LockoutCode: RecoveryLedgerUnwritable'),
    'a ledger that cannot be written no longer locks out');
});

test('the spend is written BEFORE the attempt, which is the whole crash guarantee', () => {
  const go = read(RECOVERY_GO);
  const begin = go.slice(go.indexOf('func (d *Daemon) RecoveryBeginAttempt'),
    go.indexOf('func (d *Daemon) RecoveryFinishAttempt'));
  assert(begin.length > 200, 'RecoveryBeginAttempt could not be located');
  // FROM THE SPEND ONWARD, because the budget-exhausted branch above it persists a LOCKOUT and an
  // unanchored search finds that one instead — which reported this order as inverted when it was not.
  const spendAt = begin.indexOf('d.recovery.ledger.Attempts++');
  const persistAt = begin.indexOf('d.persistLedgerLocked()', spendAt);
  const grantAt = begin.indexOf('d.recovery.inFlight = true', spendAt);
  assert(spendAt > 0 && persistAt > spendAt && grantAt > persistAt,
    'the ledger is no longer written between the spend and the grant, so an attempt a crash refunds is '
    + 'possible again');
});

test('an ABANDONED attempt never releases single-flight, deliberately', () => {
  const go = read(RECOVERY_GO);
  const abandon = go.slice(go.indexOf('func (d *Daemon) RecoveryAbandonAttempt'),
    go.indexOf('func (d *Daemon) persistLedgerLocked'));
  assert(abandon.length > 100, 'RecoveryAbandonAttempt could not be located');
  assert(!abandon.includes('d.recovery.inFlight = false'),
    'an abandoned attempt now releases single-flight, so a second remount could run against a mount point '
    + 'the first one is still inside');
});

test('the whole mount mutation stays in one goroutine, so single-flight is a shape and not a discipline', () => {
  const main = read(MAIN_GO);
  // remountLoop is called from exactly two places and both are branches of main's own select.
  const calls = (main.match(/remountLoop\(/g) ?? []).length;
  assertEq(calls, 3, 'remountLoop is not declared once and called from exactly the two supervisor branches');
  // TO THE END OF ITS OWN FUNCTION AND NO FURTHER. Slicing to end-of-file swept in remountLoop's own
  // definition, so this pin reported the recovery loop calling something it merely appears above.
  const loopStart = main.indexOf('func recoveryLoop');
  const loopEnd = main.indexOf(String.fromCharCode(10) + 'func ', loopStart + 1);
  const loop = main.slice(loopStart, loopEnd === -1 ? undefined : loopEnd);
  assert(loop.length > 200, 'recoveryLoop could not be located in main.go');
  assert(!loop.includes('remountLoop('),
    'the recovery loop now performs the remount itself, so two goroutines can mutate one mount point');
  assert(!loop.includes('fusefs.Mount('), 'the recovery loop now mounts directly');
  assert(loop.includes('RecoveryAbandonAttempt'),
    'the recovery loop no longer applies the attempt deadline');
});

test('--auto-recover is OFF by default and --reset-recovery constructs no daemon', () => {
  const main = read(MAIN_GO);
  assert(/flag\.Bool\("auto-recover", false,/.test(main),
    'automatic recovery is no longer off by default');
  assert(/flag\.Bool\("reset-recovery", false,/.test(main), '--reset-recovery is missing');
  // BRANCHED BEFORE `daemon.New`, for the same reason the healthcheck is: constructing a daemon here would
  // create the probe-cache directory from a maintenance command, as root.
  const resetAt = main.indexOf('if *resetRecovery {');
  const newAt = main.indexOf('d, err := daemon.New(cfg)');
  assert(resetAt > 0 && newAt > resetAt,
    '--reset-recovery is handled after daemon.New, so it constructs a daemon it must not');
});

test('the recovery surface is additive: no Phase 4 or Phase 5 field was renamed or removed', () => {
  const daemon = read(DAEMON_GO);
  // EVERY FIELD EVERY CLOSED GATE WAS MEASURED AGAINST. Phase 6 adds beside them and moves none of them.
  for (const field of ['`json:"ready"`', '`json:"mounted"`', '`json:"readyReason"`',
    '`json:"mountObserved"`', '`json:"mountObservedAgeMs"`', '`json:"mountLiveRunMs"`',
    '`json:"mountSinceLiveMs"`', '`json:"mountBootstrapGrace"`', '`json:"mountGraceRemainingMs"`']) {
    assert(daemon.includes(field), `the readiness document no longer carries ${field}`);
  }
  assert(daemon.includes('RecoverySnapshot\n'),
    'the recovery snapshot is no longer embedded in the status document');
});

test('the recovery surface carries no free-text field, and serveError is named as the exception', () => {
  const go = read(RECOVERY_GO);
  const snapshot = go.slice(go.indexOf('type RecoverySnapshot struct'), go.indexOf('type recoveryState struct'));
  assert(snapshot.length > 100, 'RecoverySnapshot could not be located');
  // EIGHT fields, and every one of them is a closed-set code, an int, or — in exactly one case — a digest.
  //
  // IT WAS SIX UNTIL PROJECTION PHASE 7 §8.4, which added `recoveryUnderlay` (a closed-set verdict) and
  // `recoveryUnderlayDigest` (a truncated sha256 over mountinfo identity fields). THE DIGEST IS THE ONLY FIELD
  // ON THIS SURFACE THAT IS NOT A CODE OR A NUMBER, and it is admitted for one reason: it lets a gate assert
  // from OUTSIDE the process that the attachment the daemon proved identical across a recovery really was the
  // one it fingerprinted before the first mount. It is not reversible, it cannot match a leak-scan needle, and
  // the assertion below is what keeps it from becoming a place to put a path.
  const fields = snapshot.match(/`json:"[a-zA-Z]+"`/g) ?? [];
  assertEq(fields.length, 8, 'the recovery snapshot no longer has exactly eight published fields');
  assert(!/error|Error|err\b/.test(snapshot), 'the recovery snapshot has acquired an error field');
  assert(snapshot.includes('`json:"recoveryUnderlay"`') && snapshot.includes('`json:"recoveryUnderlayDigest"`'),
    'the recovery snapshot no longer publishes the underlay verdict it takes its licence to act from');
  const doc = read(DOC);
  assert(doc.includes('`serveError` remains the one free-text field'),
    'the tranche document no longer names serveError as the one free-text field it does not touch');
});

// ---------------------------------------------------------------------------------------------------------
// The gate measures against the module, never against its own copy of a number
// ---------------------------------------------------------------------------------------------------------

test('the gate exists, and it spells no threshold and no closed-set code of its own', () => {
  if (!existsSync(GATE)) skipBlock('deploy/projection-recovery-gate.sh is NOT YET WRITTEN');
  const code = shellCodeOf(read(GATE));
  for (const [key, value] of Object.entries(PROJECTIOND_MOUNT_RECOVERY)) {
    if (typeof value !== 'number') continue;
    // ONLY THE MILLISECOND THRESHOLDS ARE SWEPT AS LITERALS, AND THAT LIMIT IS STATED RATHER THAN LEFT QUIET.
    // `RECOVERY_MAX_ATTEMPTS` is `3`, and a bare `3` occurs in `awk` field references, positional parameters
    // and array indices all over a shell script — a sweep for it flags thirty-two lines that have nothing to
    // do with the budget, which is a check nobody can keep green and therefore a check that gets deleted.
    // The small values are pinned by the assertion below instead, against the shapes that would actually be
    // a second copy of the bound.
    if (value < 1_000) continue;
    // A THRESHOLD SPELLED IN THE GATE IS A SECOND COPY OF A DERIVED NUMBER, and the drift this repository has
    // already had to retire budgets over starts exactly there.
    const literal = new RegExp(`(^|[^0-9_])${value}([^0-9]|$)`);
    const offending = code.split('\n')
      .filter((line) => literal.test(line))
      // The eval'd assignment lines carry the values legitimately; nothing else may.
      .filter((line) => !line.includes('RC_BUDGETS') && !line.includes('projection-recovery-cli'))
      // ...AND AN UNPRIVILEGED uid IS NOT A THRESHOLD. `1000:1000` is the consumer's identity and it
      // collides with RECOVERY_TICK_MS by arithmetic accident rather than by anybody copying a number.
      .filter((line) => !line.includes('1000:1000'))
      // ...AND NEITHER IS A UNIT CONVERSION. `(SOMETHING_MS / 1000)` turns a threshold READ FROM THE MODULE
      // into the seconds a `sleep` loop counts in; the 1000 there is the definition of a millisecond, not a
      // second copy of `RECOVERY_TICK_MS`. Excluding it is what keeps this pin about drift rather than
      // about arithmetic, and every line it excludes still has to name the threshold by its variable.
      .filter((line) => !/\/\s*1000\b/.test(line));
    assertEq(offending.length, 0,
      `the gate spells the literal ${value} (${key}) at: ${offending.slice(0, 2).join(' | ')}`);
  }
  // THE SMALL BOUNDS, PINNED BY THE SHAPE A SECOND COPY WOULD ACTUALLY TAKE: a comparison against a literal.
  // The gate reads `RC_RECOVERY_MAX_ATTEMPTS` from the module, so any `-eq 3` / `-ge 3` / `= "3"` in it is a
  // budget somebody typed rather than a budget somebody derived.
  assert(!/-(eq|ge|gt|le|lt)\s+3\b/.test(code) && !/=\s*"3"/.test(code),
    'the gate compares against a literal attempt budget instead of the one it read from the module');

  for (const codeWord of [...PROJECTIOND_MOUNT_RECOVERY.DECISION_CODES,
    ...PROJECTIOND_MOUNT_RECOVERY.REMEDIATIONS]) {
    if (codeWord === 'none') continue;
    assert(!code.includes(`'${codeWord}'`) && !code.includes(`"${codeWord}"`),
      `the gate spells the closed-set code ${codeWord} literally instead of reading it from the module`);
  }
});

test('the gate reads its thresholds from the module and refuses to run if it cannot', () => {
  if (!existsSync(GATE)) skipBlock('the gate is NOT YET WRITTEN');
  const gate = read(GATE);
  assert(gate.includes('src/ops/projection-recovery-cli.ts budgets --sh'),
    'the gate no longer reads its thresholds from the contract module');
  assert(/RC_BUDGETS[\s\S]{0,200}exit 1/.test(gate),
    'the gate no longer refuses to run when the thresholds cannot be read');
});

test('the gate is provider-free by construction, and says so twice in executable text', () => {
  if (!existsSync(GATE)) skipBlock('the gate is NOT YET WRITTEN');
  const gate = shellCodeOf(read(GATE));
  // TWO configurations — the subject and the blocker — and both must name no endpoint at all. Counted over
  // EXECUTABLE text: the header comment says the same thing in prose, and a comment is not a configuration.
  assertEq((gate.match(/"endpoints": \[\]/g) ?? []).length, 2,
    'one of the gate\'s daemon configurations no longer declares an empty endpoint set');
  assert(!/resolverUrl|tokenFile|allowedOrigins|directBaseUrl/.test(gate),
    'the gate mentions a provider surface, so it is no longer provider-free by construction');
});

test('every predeclared arm id appears in the gate, and a skip is a failure', () => {
  if (!existsSync(GATE)) skipBlock('the gate is NOT YET WRITTEN');
  const gate = read(GATE);
  for (let i = 1; i <= 13; i += 1) {
    assert(new RegExp(`\\bRC${i}\\b`).test(gate), `arm RC${i} is predeclared in the document and not in the gate`);
  }
  assert(/SKIPPED.*a skip is a failure here/s.test(gate) || gate.includes('and a skip is a failure here'),
    'the gate no longer treats a skipped arm as a failure');
});

test('the gate asserts the foreign overlay is STILL MOUNTED afterwards, not merely that it said so', () => {
  if (!existsSync(GATE)) skipBlock('the gate is NOT YET WRITTEN');
  const gate = read(GATE);
  assert(gate.includes('RC5_TOP_AFTER'),
    'RC5 no longer reads the top of the mount stack after the refusal, so a refusal that published the '
    + 'right word and then acted anyway would pass it');
  assert(/RC5_TOP_AFTER" = "tmpfs"[\s\S]{0,600}pass "RC5/.test(gate),
    'RC5 no longer requires the overlay to be untouched in its pass condition');
});

test('the gate guards every fault to this run\'s own container, pid and mount point', () => {
  if (!existsSync(GATE)) skipBlock('the gate is NOT YET WRITTEN');
  const gate = read(GATE);
  // THE HOST SERVES ITS ARRAY OVER shfs, WHICH IS ALSO FUSE. An unguarded abort would take it offline.
  assert(gate.includes('fstype != "fuse.projectiond"'),
    'the abort injector no longer restricts itself to projectiond mounts');
  assert(gate.includes('index(mountpoint, root "/") != 1'),
    'the abort injector no longer restricts itself to this run\'s own mount point');
  assert(/refusing to touch a namespace that is not this run's own daemon/.test(gate),
    'the gate no longer refuses to act on a namespace that is not its own');
  assert(gate.includes('nsenter -t "$DAEMON_PID" -m --'),
    'the RC8 injector no longer confines itself to this run\'s own daemon namespace by pid');
});

test('the three-runner cleans between runs, because the ledger is durable', () => {
  if (!existsSync(GATE_THREE)) skipBlock('the three-runner is NOT YET WRITTEN');
  const runner = read(GATE_THREE);
  assert(runner.includes('rm -rf "$GATE_ROOT"'),
    'the runner no longer clears the gate root between runs, so run two would inherit run one\'s spent budget');
  assert(/RC=\?77|"\$RC" -eq 77/.test(runner), 'the runner no longer treats a skip as a failure');
});

test('the recovery gate takes a port no other compose file here already holds', () => {
  if (!existsSync(COMPOSE)) skipBlock('docker-compose.projection-recovery.yml is NOT YET WRITTEN');
  // THE `}` IS PART OF THE MATCH, because the port arrives as a compose default — `${VAR:-5611}:5432` — and
  // a pattern that required the digits to abut the colon found nothing and reported "no port declared",
  // which is the same green a real clash would have produced.
  const mine = read(COMPOSE).match(/(\d{4,5})\}?:5432/);
  if (mine === null) throw new Error('the recovery gate compose file declares no PostgreSQL port');
  const port = mine[1] ?? '';
  const clashes: string[] = [];
  for (const file of readdirSync(repoRoot).filter((f) => /^docker-compose\..*\.yml$/.test(f))) {
    if (file === 'docker-compose.projection-recovery.yml') continue;
    const other = read(join(repoRoot, file));
    if (other.includes(`${port}:5432`) || other.includes(`${port}}:5432`)) clashes.push(file);
  }
  assertEq(clashes.length, 0, `the recovery gate's port ${port} is also held by: ${clashes.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------------------
// The alpha packaging
// ---------------------------------------------------------------------------------------------------------

test('the alpha profile requires every variable and defaults none of them', () => {
  if (!existsSync(ALPHA_COMPOSE)) skipBlock('docker-compose.projection-alpha.yml is NOT YET WRITTEN');
  const compose = read(ALPHA_COMPOSE);
  const required = ['PROJECTIOND_ALPHA_IMAGE', 'PROJECTIOND_ALPHA_MANIFEST_DIR', 'PROJECTIOND_ALPHA_MEDIA_ROOT',
    'PROJECTIOND_ALPHA_CACHE_DIR', 'PROJECTIOND_ALPHA_CONFIG', 'PROJECTIOND_ALPHA_SECRETS_DIR',
    'PROJECTIOND_ALPHA_MOUNT'];
  for (const name of required) {
    // `${VAR:?...}` is a refusal with a sentence; `${VAR:-default}` is an appliance that silently mounts
    // over whatever it found, which is the class of accident the whole profile exists to prevent.
    assert(compose.includes(`\${${name}:?`), `${name} has no refusing default in the alpha profile`);
    assert(!compose.includes(`\${${name}:-`), `${name} has acquired a fallback default`);
  }
});

test('the alpha profile turns recovery on VISIBLY and changes no restart policy', () => {
  if (!existsSync(ALPHA_COMPOSE)) skipBlock('the alpha profile is NOT YET WRITTEN');
  const compose = read(ALPHA_COMPOSE);
  assert(/^\s+- --auto-recover$/m.test(compose),
    'the alpha profile no longer spells --auto-recover in its own command list, so an operator reading it '
    + 'cannot see that the daemon will act');
  assert(compose.includes('restart: unless-stopped'), 'the alpha profile changed its restart policy');
  assert(!PROJECTIOND_MOUNT_RECOVERY.CHANGES_RESTART_POLICY,
    'the contract now claims recovery changes a restart policy');
  // THE CACHE IS DURABLE AND IS NOT A tmpfs. The recovery ledger lives there, and a ledger on a tmpfs is a
  // budget every restart refunds.
  assert(!/tmpfs:[\s\S]{0,200}projectiond\/cache/.test(compose),
    'the alpha profile puts the cache — and therefore the recovery ledger — on a tmpfs');
});

test('the alpha command has exactly the predeclared verbs and no others', () => {
  if (!existsSync(ALPHA_SCRIPT)) skipBlock('deploy/projection-alpha.sh is NOT YET WRITTEN');
  const script = read(ALPHA_SCRIPT);
  const dispatch = script.slice(script.lastIndexOf('case "$VERB" in'));
  for (const verb of ['preflight', 'install', 'start', 'status', 'stop', 'upgrade', 'rollback',
    'reset-recovery']) {
    assert(new RegExp(`^\\s*${verb}\\)`, 'm').test(dispatch), `the alpha command has no ${verb} verb`);
  }
  const verbs = (dispatch.match(/^\s{2}[a-z-]+\)/gm) ?? []).length;
  assertEq(verbs, 8, 'the alpha command has acquired or lost a verb');
});

test('the alpha command refuses ambiguous paths, foreign mounts and an unattached consumer', () => {
  if (!existsSync(ALPHA_SCRIPT)) skipBlock('the alpha command is NOT YET WRITTEN');
  const script = read(ALPHA_SCRIPT);
  assert(script.includes('is not an absolute path'), 'a relative path is no longer refused');
  assert(script.includes('contains an ambiguous path segment'), 'an ambiguous path is no longer refused');
  assert(script.includes('points at a host root directory'),
    'a host root directory is no longer refused, so this appliance could be pointed at /mnt/user');
  assert(script.includes('exists, is not empty, and carries no marker of this appliance'),
    'a non-empty unowned directory is no longer refused');
  assert(script.includes('already carries a mount that is not this appliance'),
    'a foreign mount at the mount point is no longer refused');
  assert(script.includes('NO CONSUMER IS ATTACHED'),
    'the consumer pre-attachment check — §11 of the Phase 0 product contract — is gone');
  assert(script.includes('names a floating tag'), 'a floating image tag is no longer refused');
});

test('the alpha command never prints a credential, and never removes data', () => {
  if (!existsSync(ALPHA_SCRIPT)) skipBlock('the alpha command is NOT YET WRITTEN');
  const script = read(ALPHA_SCRIPT);
  const code = shellCodeOf(script);
  // `down -v` WOULD REMOVE VOLUMES. Every byte this appliance holds is in a bind the operator supplied, and
  // a stop that removed volumes could remove a cache somebody's re-scan depends on.
  assert(!/compose down[^\n]*-v\b/.test(code), 'the alpha command can remove volumes');
  assert(!/rm -rf/.test(code), 'the alpha command has acquired a recursive delete');
  assert(script.includes('appears to carry a credential VALUE'),
    'the preflight no longer refuses a configuration with a credential value in it');
  // THE STATUS SURFACE PRINTS A FIXED LIST OF CLOSED-SET FIELDS, and the list lives in its own file because
  // an inline multi-line node program is a shape `test/custody-runtime-closure.ts` refuses. Anything added
  // later has to be added there on purpose, which is the whole containment.
  const fields = read(join(repoRoot, 'deploy', 'projection-alpha-status-fields.cjs'));
  assert(fields.includes('recoveryRemediation'), 'the status surface no longer prints the remediation');
  assert(fields.includes('recoveryState'), 'the status surface no longer prints the recovery state');
  // OVER THE EXECUTABLE HALF ONLY: the field file NAMES serveError in a comment explaining why it is not on
  // the list, and a sweep that read the explanation as the thing it warns about would fail on being correct.
  const fieldsCode = fields.split(String.fromCharCode(10))
    .filter((line) => !line.trimStart().startsWith('//'))
    .join(String.fromCharCode(10));
  assert(!/serveError/.test(code) && !/serveError/.test(fieldsCode),
    'the status surface prints serveError, which is the one free-text field on the readiness document');
});

test('the alpha install matrix drives the SHIPPED command and holds every predeclared arm', () => {
  const ACCEPTANCE = join(repoRoot, 'deploy', 'projection-alpha-acceptance.sh');
  if (!existsSync(ACCEPTANCE)) skipBlock('deploy/projection-alpha-acceptance.sh is NOT YET WRITTEN');
  const gate = read(ACCEPTANCE);
  // IT DRIVES THE SHIPPED SCRIPT AND NOT AN IMITATION OF IT. A matrix that reimplemented the verbs would be
  // testing itself, and every refusal it proved would be a refusal nobody had ever run.
  assert(gate.includes('bash "$HERE/projection-alpha.sh" "$@"'),
    'the install matrix no longer drives the shipped operator command');
  for (let i = 1; i <= 11; i += 1) {
    assert(new RegExp(`\\bAA${i}\\b`).test(gate), `arm AA${i} is missing from the install matrix`);
  }
  // BYTES, NEVER A METADATA SUBSTITUTE, and the consumer is attached BEFORE anything is mounted.
  assert(gate.includes('sha256sum'), 'the install matrix no longer reads bytes through the consumer');
  // BY INDEX, NOT BY A FIXED WINDOW. The two are hundreds of lines apart by design — every refusal arm runs
  // between them — so a character-count window made this pin about how much prose sits in the middle.
  const attachAt = gate.indexOf(':rslave');
  const installAt = gate.indexOf('alpha install >');
  assert(attachAt > 0 && installAt > attachAt,
    'the consumer is no longer attached before install, so §11 of the product contract is not exercised');
  assert(gate.includes('"endpoints": []'), 'the install matrix is no longer provider-free by construction');
});

test('the environment contract example names every required variable and holds no credential', () => {
  if (!existsSync(ALPHA_ENV)) skipBlock('deploy/projectiond-alpha.env.example is NOT YET WRITTEN');
  const env = read(ALPHA_ENV);
  for (const name of ['PROJECTIOND_ALPHA_IMAGE', 'PROJECTIOND_ALPHA_MANIFEST_DIR',
    'PROJECTIOND_ALPHA_MEDIA_ROOT', 'PROJECTIOND_ALPHA_CACHE_DIR', 'PROJECTIOND_ALPHA_MOUNT',
    'PROJECTIOND_ALPHA_CONFIG', 'PROJECTIOND_ALPHA_SECRETS_DIR']) {
    assert(new RegExp(`^export ${name}=$`, 'm').test(env),
      `${name} is missing from the environment contract example, or has acquired a value`);
  }
  // OVER THE `export` LINES ONLY. The prose above them explains at length that a token is a FILE, and a
  // sweep that read the explanation as the thing it warns about is a sweep that fails on being correct.
  const exports = env.split(String.fromCharCode(10)).filter((line) => line.startsWith('export '));
  const offending = exports.filter((line) => /TOKEN|APIKEY|API_KEY|PASSWORD|CREDENTIAL/i.test(line)
    || /^export [A-Z_]*SECRET(?!S_DIR)/i.test(line));
  assertEq(offending.length, 0,
    `the environment contract example has acquired a variable that could hold a credential: ${offending.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------------------
// The documents say what the code does
// ---------------------------------------------------------------------------------------------------------

test('the tranche document restates every bound, and gets them right', () => {
  const doc = read(DOC);
  for (const [key, value] of Object.entries(PROJECTIOND_MOUNT_RECOVERY)) {
    if (typeof value !== 'number') continue;
    const rendered = value >= 1_000 ? value.toLocaleString('en-US') : String(value);
    assert(doc.includes(`\`${key}\``), `the document does not mention ${key}`);
    assert(doc.includes(`**${rendered}**`),
      `the document does not state ${key} as ${rendered}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The frozen identity, and this block exists because a coordinator audit found the record was FALSE
// ---------------------------------------------------------------------------------------------------------
//
// WHAT WENT WRONG. §11.1 named a frozen commit and said the changes after it were "gate-only". Four commits
// after it modified `deploy/projection-alpha.sh` — the SHIPPED OPERATOR COMMAND — and two modified the
// acceptance gate. So the 11/11 install matrix had necessarily measured later source than the record claimed,
// and the closure did not rest on one frozen source at all. Nothing in the suite could see it, because every
// pin here read prose and prose is exactly what was wrong.
//
// WHAT MAKES IT UNREPEATABLE. A record that merely NAMES a commit can go stale silently; a record that
// carries a DIGEST OF THE SHIPPED SOURCE ITSELF cannot. These two digests are recomputed from the working
// tree on every run and compared with what the closure record claims. Edit the operator command after
// closure and the record stops matching — which is the defect, caught at the moment it is introduced rather
// than by an audit afterwards.
const SOURCE_SETS: Readonly<Record<string, readonly string[]>> = {
  // The shipped operator product: what an operator actually runs.
  OPERATOR: [
    'deploy/projection-alpha.sh',
    'deploy/projection-alpha-status-fields.cjs',
    'deploy/projection-alpha-status-port.cjs',
    'deploy/projectiond-alpha.env.example',
    'docker-compose.projection-alpha.yml',
  ],
  // The things that MEASURE it. A gate that changed after the run it certifies is the same defect wearing
  // different clothes.
  GATE: [
    'deploy/projection-alpha-acceptance.sh',
    'deploy/projection-recovery-gate-optional.sh',
    'deploy/projection-recovery-gate-three.sh',
    'deploy/projection-recovery-gate.sh',
    'docker-compose.projection-recovery.yml',
    'src/ops/projection-recovery-cli.ts',
  ],
};

/**
 * A digest over a named set of source files.
 *
 * NORMALISED TO LF, because `.gitattributes` marks some files `eol=crlf` and a checkout on Windows would
 * otherwise disagree with the same bytes on the Unraid host they were staged to — which would make this pin
 * fail for a reason that has nothing to do with drift.
 *
 * THE PATH IS IN THE DIGEST, so renaming a file out of the set is a change rather than a silent removal.
 */
function sourceDigest(paths: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    hash.update(path, 'utf8');
    hash.update('\n', 'utf8');
    hash.update(read(join(repoRoot, path)).replace(/\r\n/g, '\n'), 'utf8');
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}

/** Whether the readiness decision currently claims GO. A record that does is a CLOSURE record. */
const claimsGo = (doc: string): boolean =>
  /\*\*GO\*\*|^# \*\*GO —/m.test(doc.slice(doc.indexOf('## 12.'), doc.indexOf('## 13.')));

test('the closure record names a frozen COMMIT and a frozen TREE, not just a commit', () => {
  const doc = read(DOC);
  const identity = doc.slice(doc.indexOf('### 11.1'), doc.indexOf('### 11.1.1'));
  assert(identity.length > 100, 'the frozen identity section could not be located');

  // A CANDIDATE MAY HOLD ITS OWN IDENTITY, BECAUSE IT CANNOT KNOW IT YET. The commit that is frozen and
  // staged to the host is the commit that CONTAINS this document, so its own hash is not knowable while it is
  // being written; the identity is recorded in the commit that follows the runs. That is the repository's
  // ordinary sequence and it is not a licence — a record that claims GO while holding its identity is
  // claiming a closure nobody can check, and that is the exact shape of the defect this block exists for.
  // THE HELD STATE IS A TABLE ROW, NOT A WORD ANYWHERE IN THE SECTION. Matching the bare word made the
  // section's own EXPLANATION of why it had once been held read as the held state itself, so the block
  // skipped — asserting nothing — on a record that was fully filled in.
  if (/\|\s*frozen (commit|tree)\s*\|\s*\*\*HELD\*\*/.test(identity)) {
    assert(!claimsGo(doc),
      'the readiness decision claims GO while the frozen identity is still HELD, so the closure names no '
      + 'source anybody could verify it against');
    skipBlock('the frozen identity is HELD in a candidate that does not claim GO');
  }
  // A COMMIT WITHOUT A TREE IS AN IDENTITY THAT CANNOT BE CHECKED AGAINST A STAGED COPY. The whole freeze
  // procedure ends by comparing a host tree against `git archive`, and the tree hash is what that compares.
  const hashes = identity.match(/\b[0-9a-f]{40}\b/g) ?? [];
  assert(hashes.length >= 2,
    'the frozen identity names fewer than two 40-hex objects, so it cannot carry both a commit and a tree');
  assert(/frozen commit/i.test(identity), 'the frozen identity does not name a frozen commit');
  assert(/frozen tree/i.test(identity), 'the frozen identity does not name a frozen tree');
  assert(/sha256:[0-9a-f]{64}/.test(identity), 'the frozen identity names no image digest');
});

test('the closure record\'s SHIPPED SOURCE digests still describe the working tree', () => {
  const doc = read(DOC);
  for (const [name, paths] of Object.entries(SOURCE_SETS)) {
    const actual = sourceDigest(paths);
    const claimed = doc.match(new RegExp(`${name} SOURCE DIGEST\\s*\\|\\s*\`([0-9a-f]{64})\``));
    if (claimed === null) {
      throw new Error(`the closure record carries no ${name} SOURCE DIGEST, so its frozen identity cannot `
        + 'be checked');
    }
    assertEq(claimed[1] ?? '', actual,
      `the ${name} source has changed since the closure record was written. THE RECORD IS NOW FALSE: it `
      + 'certifies a run of source that no longer exists. Re-freeze, re-run the affected acceptance, and '
      + 'update the digest — do not edit the digest to match');
  }
});

test('every source file the digests cover actually exists, so the sets cannot rot into nothing', () => {
  // A DIGEST OVER A SET THAT LOST A MEMBER IS STILL A DIGEST, and it would pass forever while covering less.
  for (const [name, paths] of Object.entries(SOURCE_SETS)) {
    for (const path of paths) {
      assert(existsSync(join(repoRoot, path)), `${name} names ${path}, which does not exist`);
    }
  }
  assertEq(SOURCE_SETS.OPERATOR?.length, 5, 'the operator source set changed size');
  assertEq(SOURCE_SETS.GATE?.length, 6, 'the gate source set changed size');
});

test('no evidence block claims a frozen source without naming one', () => {
  const doc = read(DOC);
  const record = doc.slice(doc.indexOf('## 11. Run record'), doc.indexOf('## 12.'));
  // EVERY BLOCK THAT REPORTS A MEASUREMENT MUST SAY WHICH FROZEN SOURCE IT CAME FROM. The audit's finding was
  // not one wrong hash — it was that four separate evidence blocks were silently attributed to a source none
  // of them ran from.
  for (const heading of ['### 11.2', '### 11.4', '### 11.5', '### 11.6']) {
    const start = record.indexOf(heading);
    assert(start > 0, `the run record has no ${heading}`);
    const end = record.indexOf('### 11.', start + 8);
    const block = record.slice(start, end === -1 ? undefined : end);
    assert(/frozen source|frozen commit|frozen tree|frozen image|`[0-9a-f]{7,40}`/.test(block),
      `${heading} reports a measurement without naming the frozen source it came from`);
  }
});

test('the phrase that made the record false cannot come back unmarked', () => {
  const doc = read(DOC);
  // "gate-only" WAS THE EXACT WORD THAT WAS WRONG. It is kept where the record explains that it was wrong —
  // this repository keeps superseded wording rather than deleting it — and it may appear nowhere else.
  // SCOPED TO THE PARAGRAPH, NOT THE LINE. The correction discusses the phrase across several sentences, and
  // a line-scoped rule fired on the very sentence explaining that it was false — which would have pushed the
  // next person to delete the explanation rather than keep it. A paragraph that quotes the phrase must also
  // say, somewhere in itself, that it is being quoted rather than claimed.
  for (const paragraph of doc.split(/\n\s*\n/)) {
    if (!/gate-only|gate only/i.test(paragraph)) continue;
    assert(/HISTORICALLY|SUPERSEDED|FALSE|was wrong|were NOT/i.test(paragraph),
      `an unmarked "gate-only" claim is back: ${paragraph.trim().slice(0, 140)}`);
  }
});

test('the tranche document holds its run record and its decision until they are measured', () => {
  const doc = read(DOC);
  // A DOCUMENT THAT CLAIMS A RESULT BEFORE THE RUN IS THE FAILURE MODE THE ROADMAP'S ANTI-DETOUR RULE
  // EXISTS FOR. This pin is what stops §11 and §12 being written from an intention.
  const record = doc.slice(doc.indexOf('## 11. Run record'), doc.indexOf('## 13.'));
  assert(record.length > 100, 'the run record section could not be located');
  // THE IMPLICATION RUNS ONE WAY, AND WRITING IT AS AN EQUALITY WAS WRONG. A measured closure of the recovery
  // gate does not by itself make the ALPHA a GO — the readiness decision also depends on the regression
  // matrix, the install matrix and the narrow real-provider acceptance, any of which can hold it at NO-GO
  // with the gate perfectly closed. What must never happen is the other direction: a GO written without a
  // measured closure under it. That is the thing this pin exists to make impossible.
  const measured = /three consecutive fresh runs, exit 0/.test(record);
  const decision = /\*\*GO\*\*/.test(doc.slice(doc.indexOf('## 12.'), doc.indexOf('## 13.')));
  assert(!decision || measured,
    'the readiness decision says GO and the run record records no measured closure, so it was written from '
    + 'an intention');
});

test('the roadmap records Phase 5 CLOSED with its exact frozen identity and claims nothing more', () => {
  const roadmap = read(ROADMAP);
  const row = roadmap.split('\n').find((line) => line.startsWith('| **Projection Phase 5**'));
  if (row === undefined) throw new Error('the roadmap has no Phase 5 row');
  assert(row.includes('57b4a3646332fe7b1335da18d7c15d5807090b63'), 'the Phase 5 row names no frozen commit');
  assert(row.includes('5eeaca7befff4e94ac7a91a981d49c0a1341c9fb'), 'the Phase 5 row names no frozen tree');
  assert(row.includes('sha256:73996926dafa3078609b2ab9534032ff7032b30322fa9bcbac31643efdf82786'),
    'the Phase 5 row names no frozen image');
  assert(row.includes('36 arm verdicts, 36 pass, 0 fail, 0 skip'), 'the Phase 5 row states no evidence count');
  // ...AND THE NONCLAIMS, which are the half a roadmap row usually loses.
  assert(row.includes('it reports, it does not act'),
    'the Phase 5 row no longer records that it acted on nothing, which is the sentence Phase 6 exists to spend');
  assert(row.includes('no G-number'), 'the Phase 5 row no longer records that it closes no G-number');
  const six = roadmap.split('\n').find((line) => line.startsWith('| **Projection Phase 6**'));
  if (six === undefined) throw new Error('the roadmap has no Phase 6 row');
  // A ROW MAY SAY `OPEN` HOLDING NOTHING, OR `CLOSED` HOLDING EVERYTHING — AND NOTHING IN BETWEEN. This pin
  // was written when the row said OPEN and it demanded that word, which would have made closing the tranche
  // a test failure. What it is actually for is the other case: a CLOSED row that does not name the image its
  // figures came from, the counts, or what it refuses to claim is a row somebody will read as meaning more
  // than it says.
  // ...AND `CLOSED` IS THE ONLY WORD THAT BUYS ANYTHING. A row may be OPEN, or RE-FREEZING after a closure
  // was withdrawn, or anything else a truthful sequence needs — the rule is that every state except CLOSED
  // must say in the row itself that it holds nothing. Demanding one of two exact words was a pin that would
  // have had to be edited to tell the truth, which is the wrong way round.
  if (!six.includes('**CLOSED**')) {
    assert(/holds? \*\*nothing\*\*|holding \*\*nothing\*\*/.test(six),
      'a Phase 6 row that is not CLOSED must say in the row that it holds nothing');
  } else {
    assert(/sha256:[0-9a-f]{64}/.test(six),
      'the CLOSED Phase 6 row names no frozen image, so its figures describe nothing in particular');
    assert(/\d+ arm verdicts, \d+ pass, 0 fail, 0 skip/.test(six),
      'the CLOSED Phase 6 row states no evidence count');
    assert(six.includes('does NOT close'),
      'the CLOSED Phase 6 row records no nonclaims, which is the half a roadmap row usually loses');
    assert(six.includes('No threshold moved'),
      'the CLOSED Phase 6 row does not say whether a threshold moved after measurement');
  }
});

test('the Go table drives the shipped decision and covers both sides of the sustain boundary', () => {
  const go = read(RECOVERY_TEST_GO);
  assert(go.includes('decideRecovery(in)'), 'the Go table no longer drives the shipped decision function');
  assert(go.includes('a fault sustained for exactly the window is still not acted on'),
    'the sustain boundary case is gone — this is the case that caught the product defect');
  assert(go.includes('TestTheLockoutSurvivesTheProcess'),
    'nothing pins that the lockout survives a restart, which is what makes the budget a bound');
  assert(go.includes('TestClassificationIsExhaustiveOnEveryReadinessReason'),
    'nothing pins the classification against the full readiness reason set');
});

test('the recovery CLI publishes every code and refuses to publish a broken derivation', () => {
  const cli = read(RECOVERY_CLI);
  assert(cli.includes('RECOVERY_NEVER_ACTS_ON_A_FAULT_READINESS_DID_NOT_BELIEVE'),
    'the CLI no longer checks the derivations it publishes');
  assert(/process\.exit\(1\)/.test(cli), 'the CLI no longer fails when a derivation stops holding');
  assert(cli.includes('DECISION_CODES'), 'the CLI no longer publishes the decision codes');
});

// ---------------------------------------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed${skippedBlocks.length ? `, ${skippedBlocks.length} SKIPPED` : ''}\n`);
for (const [name, error] of failures) {
  console.log(`FAILED: ${name}`);
  console.log(`  ${(error as Error).message}`);
}
if (skippedBlocks.length > 0) {
  console.log('SKIPPED BLOCKS — these asserted NOTHING:');
  for (const block of skippedBlocks) console.log(`  - ${block}`);
}
process.exit(failed === 0 ? 0 : 1);
