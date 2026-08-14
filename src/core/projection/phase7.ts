// Projection Phase 7 — the operator-usable alpha's rules, as code rather than as prose.
//
// WHAT PHASE 7 IS, IN ONE SENTENCE. Phase 6's bounded automatic recovery, done to a mount that THREE REAL
// MEDIA SERVERS are attached to and playing real provider bytes through — which is the intersection Phase 6
// deliberately left empty and said so in its own §12.6: "no media server was in any Phase 6 run".
//
// WHY THE INTERSECTION IS NOT IMPLIED BY THE HALVES, AND THE ARGUMENT IS THE SAME ONE PHASE 3 MADE AND WON.
// Phase 2's worst defect was `--auto-remount` recovering the namespace FOR THE DAEMON AND FOR NOBODY ELSE:
// the daemon logged success, `/readyz` said ready, and no consumer could see a file. Phase 6's recovery
// supervisor calls the same remount for a second reason, and every one of its thirteen arms used a single
// unprivileged byte-reading consumer. A recovery that satisfies that consumer and loses a media server's
// open handles, library, item ids or bind is a recovery this repository has no evidence about.
//
// EVERY NUMBER HERE IS DERIVED OR SAYS IT IS CHOSEN. Where Phase 3 already derived the same quantity, THIS
// FILE IMPORTS PHASE 3's rather than deriving it a second time: two derivations of one budget are two
// budgets the moment either is edited. `test/projection-phase7.ts` fails if any of it drifts.
//
// NOTHING HERE IMPORTS A GATE OR TOUCHES A FILESYSTEM.

import {
  PROJECTIOND_MOUNT_HEALTH,
  PROJECTIOND_MOUNT_RECOVERY,
  PROJECTIOND_MOUNT_OBSERVATION,
  PROJECTIOND_MOUNT_TARGET,
  PROJECTION_PHASE_1_BUDGETS,
} from './runtime-contract.js';
import { MEDIA_SERVER_SOAK, type GateResult } from './media-server-dataplane.js';
import { RELIABILITY_LOOP_RULES, RELIABILITY_POLL_INTERVAL_MS } from './reliability-loop.js';

/**
 * The six recovery arms, in the order the gate runs them, and the order is part of the contract.
 *
 * WHY THIS ORDER. `R1` and `R2` are the two the recovery supervisor ACTS on and they come first, so every
 * later arm is done to a daemon that has already spent and been refunded a budget — which is the state an
 * appliance is actually in after a week. `R3` is the CONTROL and it is deliberately in the middle: a
 * supervisor that had become trigger-happy would have had two chances to prove it by then. `R4` and `R5` are
 * the two REFUSALS, and `R6` is last because it ends in a durable lockout that has to be cleared by hand —
 * running anything after it would be running it against a daemon that has been told to stop.
 */
export const PHASE7_ARMS = Object.freeze([
  'R1', // the mount taken out from under a living daemon — the recovery loop acts
  'R2', // this daemon's own stale mount stacked above — the recovery loop acts
  'R3', // a provider outage past the breaker's budget, then restoration — the recovery loop must NOT act
  'R4', // a serve-loop death — the serve supervisor acts, and EXACTLY one supervisor does
  'R5', // a foreign overlay — REFUSED, and the overlay is asserted still mounted and unmodified
  'R6', // an unrecoverable fault — exactly the bounded budget, a durable lockout, then an operator reset
] as const);

export type Phase7Arm = (typeof PHASE7_ARMS)[number];

/** What each arm is, in one line, for the report. Never a path, an address or a reference. */
export const PHASE7_ARM_TITLES: Readonly<Record<Phase7Arm, string>> = Object.freeze({
  R1: 'the mount lost beneath a living daemon, recovered by the recovery supervisor',
  R2: "this daemon's own stale mount stacked above the live one, recovered",
  R3: 'a sustained provider outage past the breaker cooldown — the mount is untouched and NOTHING recovers',
  R4: 'a serve-loop death, with EXACTLY one supervisor acting on it',
  R5: 'a foreign overlay, REFUSED, and asserted still mounted and unmodified afterwards',
  R6: 'an unrecoverable fault: the whole budget, a durable lockout across a restart, then an operator reset',
});

/** Which arms the recovery supervisor is expected to ACT on. The other four are controls or refusals. */
export const PHASE7_ACTIONABLE_ARMS: readonly Phase7Arm[] = Object.freeze(['R1', 'R2', 'R6']);

/** The three servers, in the same order and under the same ids the rest of the repository uses. */
export const PHASE7_SERVER_IDS = Object.freeze(['emby', 'jellyfin', 'plex'] as const);
export type Phase7ServerId = (typeof PHASE7_SERVER_IDS)[number];

/**
 * The pointer poll the gate configures on the daemon.
 *
 * IT IS PHASE 3's, IMPORTED. `READY_BUDGET_MS` is derived from it, and a second spelling of it here would be
 * a second budget the moment either moved.
 */
export const PHASE7_POLL_INTERVAL_MS = RELIABILITY_POLL_INTERVAL_MS;

/**
 * Every threshold Phase 7 names.
 *
 * DERIVED MEANS DERIVED. Each entry either computes from a `runtime-contract.ts` constant, imports Phase 3's
 * already-derived one, or carries a comment saying it was CHOSEN and naming both of its bounds.
 */
export const PHASE7_RULES = Object.freeze({
  /** One arm per recovery fault. The arm list IS the fault list; this is not a round number. */
  ARMS_PER_RUN: PHASE7_ARMS.length,

  /** The repository's own closure convention, unchanged since the first gate that ever closed. */
  CONSECUTIVE_FRESH_RUNS: RELIABILITY_LOOP_RULES.CONSECUTIVE_FRESH_RUNS,

  /**
   * From a daemon start to a namespace a sibling container can read again.
   *
   * PHASE 3's, IMPORTED RATHER THAN RE-DERIVED. It bounds the same two waits — one pointer poll and one read
   * deadline — and Phase 7 changes neither.
   */
  READY_BUDGET_MS: RELIABILITY_LOOP_RULES.READY_BUDGET_MS,

  /** A read that fails during an outage fails inside the product's own deadline. Phase 3's, imported. */
  READ_FAIL_BUDGET_MS: RELIABILITY_LOOP_RULES.READ_FAIL_BUDGET_MS,

  /** An open breaker refuses before any admitted read could have got a slot. Phase 3's, imported. */
  BREAKER_REFUSAL_BUDGET_MS: RELIABILITY_LOOP_RULES.BREAKER_REFUSAL_BUDGET_MS,

  /** From the release instant to a successful digest-matching read. Phase 3's, imported. */
  OUTAGE_RECOVERY_BUDGET_MS: RELIABILITY_LOOP_RULES.OUTAGE_RECOVERY_BUDGET_MS,

  /** While the breaker is open, zero packets leave the host. Phase 3's, imported. */
  HOLD_RESOLVER_REQUESTS_MAX: RELIABILITY_LOOP_RULES.HOLD_RESOLVER_REQUESTS_MAX,

  /** How long R3 reads against an open breaker before releasing. Phase 3's, imported. */
  HOLD_WINDOW_MS: RELIABILITY_LOOP_RULES.HOLD_WINDOW_MS,

  /** Half-open lets exactly one request through. Phase 3's, imported. */
  HALF_OPEN_PROBES: RELIABILITY_LOOP_RULES.HALF_OPEN_PROBES,

  /** Items added or removed across any arm, on any server. Phase 1's budget, imported. */
  LIBRARY_CHURN_MAX: PROJECTION_PHASE_1_BUDGETS.MAX_LIBRARY_CHURN_ITEMS,

  /** The operator records these outside the mount before any run; the gate compares, it does not compute. */
  OPERATOR_WINDOWS_REQUIRED: RELIABILITY_LOOP_RULES.OPERATOR_WINDOWS_REQUIRED,

  // -------------------------------------------------------------------------------------------------------
  // THE PLAYBACK WINDOW — PHASE 1's, AT PHASE 1's OWN NUMBERS, AND THIS IS WHERE PHASE 7 DIFFERS FROM PHASE 3
  // -------------------------------------------------------------------------------------------------------
  //
  // PHASE 3 CHOSE THIRTY SECONDS AND SAID SO. Its §4 names both bounds: below, the shipped drivers' own floor
  // of thirty progress records; above, an acceptance plan that calls the real-provider corpus a correctness
  // corpus and never a load test. Phase 7's product claim is different — "a real operator can use this" — and
  // thirty seconds of decoded media does not support it. So the window here is the one Phase 1 already
  // established and closed against on this host, imported rather than re-argued.
  //
  // WHAT THAT COSTS, STATED RATHER THAN GLOSSED: five minutes of direct play and five minutes of forced
  // transcode, on each of three servers, on each of three runs, against a metered account. That is the
  // deliberate price of the claim and it is bounded by the corpus (one object) and by the run count (three).

  /** G8's own ten seconds: from launching the consumer to its first decoded output. */
  PLAY_START_BUDGET_MS: MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS * 1_000,

  /** G8's own five minutes of DECODED MEDIA TIME — not wall clock a sleep can also produce. */
  PLAY_DECODED_SECONDS_MIN: MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS,

  /** G10's own five minutes of decoded, continuously consumed, forced-transcode output. */
  TRANSCODE_DECODED_SECONDS_MIN: MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS,

  /** G9's ten distinct media-time positions, including backwards ones and one beyond 90% of duration. */
  SEEK_COUNT: MEDIA_SERVER_SOAK.SEEK_COUNT,

  // -------------------------------------------------------------------------------------------------------
  // THE RECOVERY BUDGETS — every one of them derived from Phase 6's own predeclared constants
  // -------------------------------------------------------------------------------------------------------

  /**
   * From injecting a fault to the recovery supervisor having SPENT an attempt on it.
   *
   * DERIVED, AND THE DERIVATION IS PHASE 6 §3.3's OWN ARITHMETIC RATHER THAN A NUMBER PICKED TO FIT.
   * Readiness must first believe the fault, which costs a whole `MOUNT_FAULT_HOLD_MS`; the supervisor then
   * requires the fault to sustain a second whole hold, which is `RECOVERY_SUSTAIN_MS`; the decision is taken
   * on a tick, which costs at most one `RECOVERY_TICK_MS`; and the attempt itself may run to
   * `RECOVERY_ATTEMPT_DEADLINE_MS` before it is counted and abandoned. Phase 6 says in its own words that
   * time-to-act "is therefore the sum — twelve seconds of a fault nobody else fixed — and it is supposed to
   * be"; this adds the tick and the attempt because what is being bounded here is the attempt's END.
   */
  RECOVERY_ACTION_BUDGET_MS:
    PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_SUSTAIN_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_TICK_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_ATTEMPT_DEADLINE_MS,

  /**
   * From injecting a fault to a sibling container reading a byte through the mount again.
   *
   * DERIVED: the whole action budget above, plus the confirmation window that has to elapse before `ok` can
   * be re-derived from an observation taken AFTER the attempt, plus the same daemon-readiness budget every
   * other recovery in this repository is measured against.
   */
  RECOVERY_READY_BUDGET_MS:
    PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_SUSTAIN_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_TICK_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_ATTEMPT_DEADLINE_MS
    + PROJECTIOND_MOUNT_RECOVERY.RECOVERY_CONFIRM_MS
    + RELIABILITY_LOOP_RULES.READY_BUDGET_MS,

  /** Phase 6's durable budget, imported. A fourth attempt at an action that has failed three times is a loop. */
  RECOVERY_MAX_ATTEMPTS: PROJECTIOND_MOUNT_RECOVERY.RECOVERY_MAX_ATTEMPTS,

  /** The gap two consecutive attempt starts must clear. Phase 6's, imported. */
  RECOVERY_COOLDOWN_MS: PROJECTIOND_MOUNT_RECOVERY.RECOVERY_COOLDOWN_MS,

  /**
   * How long R6 watches a locked-out daemon to prove the generation does not advance.
   *
   * DERIVED, AND IT IS PHASE 6 `RC9`'s OWN RULE: two whole cooldowns. One would be satisfied by a supervisor
   * that was merely between attempts.
   */
  LOCKOUT_QUIET_WINDOW_MS: 2 * PROJECTIOND_MOUNT_RECOVERY.RECOVERY_COOLDOWN_MS,

  /**
   * EXACTLY ONE recovery action across both supervisors, per fault.
   *
   * Phase 6 §3.4 makes single-flight a property of the program's shape rather than a discipline: the recovery
   * loop REQUESTS over a channel and the goroutine that already owns the mount is the only thing that ever
   * calls `remountLoop`. This is that property, measured from the outside, with three media servers holding
   * the mount — which is the topology where two remounts racing on one mount point would cost the most.
   */
  SINGLE_FLIGHT_ACTIONS_MAX: 1,

  // -------------------------------------------------------------------------------------------------------
  // THE MOUNT-TOPOLOGY CLAUSE — the one threshold Phase 7 adds that no earlier tranche has ever asserted
  // -------------------------------------------------------------------------------------------------------

  /**
   * How many of THIS DAEMON's mounts may be stacked at the projected mount point once an arm has settled,
   * counted ABOVE the floor of whatever was already mounted there before the daemon started.
   *
   * ONE. There is one namespace being served, so there is one live layer, and every other layer is a dead
   * one nobody can read through.
   *
   * THIS IS A REAL THRESHOLD AND IT IS EXPECTED TO BITE. Phase 6 §9.7 measured the opposite on this host and
   * recorded it as a rough edge: "a recovery usually STACKS OVER the corpse rather than removing it ... a
   * mount point which has survived several recoveries carries several of this daemon's dead layers", with
   * "removing them safely" named as next work rather than done. Phase 7 is where that is either fixed or
   * honestly refused: an appliance whose mount point grows a dead layer per fault is one that eventually
   * meets the OTHER rough edge in that list — §9.6, a mount point nothing can bind — with no operator
   * involved and no warning.
   *
   * IT IS COUNTED ABOVE A FLOOR AND NEVER ABSOLUTELY, for the reason the daemon's own drain is written
   * around: in a container the mount point IS the operator's bind, and on an Unraid host that bind's
   * file-system type is the host's own FUSE. Anything that counted absolutely would be counting the
   * operator's mount as one of the daemon's.
   */
  MOUNT_LAYERS_ABOVE_FLOOR_MAX: 1,

  /**
   * ...and the same count taken at the END of the run, after every arm, which is the accumulation question
   * rather than the per-arm one. It is deliberately the same number: a bound that grew with the arm count
   * would be a bound on nothing.
   */
  MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END: 1,
} as const);

/**
 * A DERIVED FACT THE WHOLE RECOVERY HALF DEPENDS ON, CHECKED WHERE THE BUDGETS ARE PUBLISHED.
 *
 * Phase 6's first bound is free only because the sustain outlasts the fault hold: a supervisor that acted
 * before readiness believed the fault would be acting on a sampling artefact. Phase 7 measures against a
 * budget derived from both, so if that relation ever stopped holding the budget would be describing an order
 * of events that no longer happens.
 */
export const RECOVERY_SUSTAIN_OUTLASTS_THE_FAULT_HOLD =
  PROJECTIOND_MOUNT_RECOVERY.RECOVERY_SUSTAIN_MS >= PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS;

/**
 * ...AND THE FLOOR THE LAYER COUNT IS TAKEN ABOVE IS A FLOOR THE PRODUCT ITSELF PROMISES NEVER TO GO BELOW.
 *
 * Counting layers ABOVE what was already mounted is only meaningful while the daemon is forbidden from
 * removing what was already mounted. `ANCHOR_IS_NEVER_DETACHED_TO_MAKE_ROOM` is that promise, and it is the
 * one `--auto-remount` broke: it unmounted the operator's bind and recovered for the daemon and for nobody
 * else. A contract that counted above a floor the daemon was allowed to lower would be counting nothing.
 */
export const THE_LAYER_FLOOR_IS_A_FLOOR_THE_PRODUCT_PROMISES =
  PROJECTIOND_MOUNT_TARGET.ANCHOR_IS_NEVER_DETACHED_TO_MAKE_ROOM === true;

/**
 * ...AND THE OBSERVATION THE SUPERVISOR ACTS ON IS SAMPLED, SINGLE-FLIGHT, AND CAN GO STALE.
 *
 * Phase 6 §9.2 is the rough edge this names: a probe parked in an uninterruptible `statfs` releases only when
 * the connection is torn down, and the sampler is single-flight by construction, so a recovery that remounts
 * AROUND such a probe can leave the observation permanently unavailable — which spends the budget and locks
 * out. Phase 7 does not fix that; §9 of its own document records what it looked for and what it found.
 */
export const THE_OBSERVATION_IS_SINGLE_FLIGHT_AND_CAN_AGE =
  PROJECTIOND_MOUNT_OBSERVATION.SINGLE_FLIGHT === true;

/**
 * The nonclaims, printed by the gate at the end of every run, on the PASSING path.
 *
 * A list of things a gate does not prove, kept in a document nobody opens after a green run, is a list that
 * stops being read exactly when it matters.
 */
export const PHASE7_NONCLAIMS: readonly string[] = Object.freeze([
  'It is not a load test and no figure here is a performance claim. ONE object, four 64 KiB windows, and one '
  + 'five-minute direct play and one five-minute forced transcode per server per run.',
  'It re-closes none of G7-G13, G18 or G22. The ~50-entry corpus is not here, so nothing about scan cost, '
  + 'amplification, concurrency budgets or re-scan churn AT CORPUS SCALE is measured.',
  'PER-SERVER PROVIDER ATTRIBUTION IS IMPOSSIBLE WITH ONE SHARED DAEMON AND IS NOT CLAIMED. Three servers '
  + 'read one mount through one cache; no byte is attributed to a server, exactly as G18 has always said.',
  'The forced transcode does not claim five minutes of ENCODER work. Phase 1 measured the encoder finishing '
  + 'a short source in about 1.6 seconds and recorded it; what is asserted is five minutes of paced, '
  + 'continuously consumed, decoded transcoded output, and the encoder figure is reported beside it.',
  'It declares no winner between frontends and is not a bake-off. ADR-002 is untouched and rclone is not '
  + 'the architecture.',
  'One object is one object, one host is one host, and one provider is one provider. Real-Debrid and Usenet '
  + 'have named contracts rather than support.',
  'Provider bytes are NOT counted: there is no counter on the far side of a real CDN. What is bounded is '
  + 'what the gate itself asks for.',
  'No 429 was provoked and none is asserted.',
  'A recovery is not an availability claim. The daemon repairs a bounded set of mount faults a bounded '
  + 'number of times, and a fault outside Phase 6 §3.2s table is one it reports and does not touch.',
]);

// ---------------------------------------------------------------------------------------------------------
// The closure check
// ---------------------------------------------------------------------------------------------------------

/**
 * The per-arm measurements, without the arm suffix.
 *
 * WHY EVERY ACTIONABLE ARM CARRIES THE SAME SEVEN AND THE REFUSALS DO NOT. The task these arms exist for is
 * "prove status/reason/remediation, single-flight ownership, bounded timing and attempts, readiness
 * restoration, the SAME pre-attached consumers and binds, byte digest continuity, and renewed media-server
 * read and playback without container rebinding". An arm that recovered and could not show all seven has
 * shown a daemon recovering for itself, which is the defect this whole line of work started from.
 */
export const PHASE7_ARM_DETAIL_GATE_IDS: Readonly<Record<Phase7Arm, readonly string[]>> = Object.freeze({
  R1: Object.freeze([
    'P7-R1-fault-took-the-mount', 'P7-R1-reason', 'P7-R1-remediation', 'P7-R1-attempts',
    'P7-R1-single-flight', 'P7-R1-action-ms', 'P7-R1-ready-ms', 'P7-R1-generation',
  ]),
  R2: Object.freeze([
    'P7-R2-corpse-was-stale', 'P7-R2-reason', 'P7-R2-remediation', 'P7-R2-attempts',
    'P7-R2-single-flight', 'P7-R2-action-ms', 'P7-R2-ready-ms', 'P7-R2-generation',
  ]),
  // R3 IS THE CONTROL AND ITS WHOLE ASSERTION IS AN ABSENCE. A provider outage never touches the mount, so a
  // recovery supervisor that had become trigger-happy fails here and nowhere else in this gate.
  // AND THE ABSENCE IS ASSERTED OF BOTH SUPERVISORS AND OF THE RESTART, WHICH IS WHAT §11.4 #16 COST. The
  // eight above are all about the RECOVERY supervisor, and it is blind to the serve-death path by design: a
  // remount taken there advances no generation and logs no `recovery:` line. So a live layer could appear in
  // this arm with every one of them passing, which is exactly what two six-arm runs measured. The last three
  // are the diagnostic §11.3.5 named — a serve-death observation, a single-flight count across BOTH
  // supervisors, and the mount point coming back to the floor between the two daemons this arm replaces.
  R3: Object.freeze([
    'P7-R3-read-fail-ms', 'P7-R3-breaker-opened', 'P7-R3-refusal-ms', 'P7-R3-hold-resolver-requests',
    'P7-R3-recovery-ms', 'P7-R3-half-open-probes', 'P7-R3-no-recovery-action', 'P7-R3-mount-untouched',
    'P7-R3-no-serve-death', 'P7-R3-single-flight', 'P7-R3-restart-left-no-layer',
  ]),
  // R4's ASSERTION IS THAT EXACTLY ONE SUPERVISOR ACTED. Phase 6 declines `serve-loop-dead` because the
  // serve-death path already owns it and two supervisors on one mount point is the worst blast radius in
  // this product; what makes that a measurement rather than a design note is counting both.
  R4: Object.freeze([
    'P7-R4-serve-death-observed', 'P7-R4-remounted-in-place', 'P7-R4-recovery-declined',
    'P7-R4-single-flight', 'P7-R4-ready-ms', 'P7-R4-identity-unchanged',
  ]),
  // R5's ASSERTION IS A REFUSAL AND THE OVERLAY BEING UNTOUCHED, which is the row Phase 6 called the most
  // important one it has: the likeliest foreign mount at a projection mount point is the operator's own bind.
  R5: Object.freeze([
    'P7-R5-reason', 'P7-R5-remediation', 'P7-R5-attempts', 'P7-R5-generation',
    'P7-R5-overlay-still-mounted', 'P7-R5-overlay-unmodified',
  ]),
  R6: Object.freeze([
    'P7-R6-attempts-spent', 'P7-R6-cooldown-ms', 'P7-R6-state-locked-out', 'P7-R6-remediation',
    'P7-R6-lockout-survived-restart', 'P7-R6-quiet-while-locked-out', 'P7-R6-reset-cleared-it',
    'P7-R6-ready-after-reset',
  ]),
});

/**
 * The ids every arm carries, whatever it was.
 *
 * THE MOUNT TOPOLOGY IS HERE AND NOT IN THE PER-ARM TABLE, because the question "did this fault leave a dead
 * layer behind" has to be asked of the arms that recover AND of the arms that refuse. An arm that refused to
 * act and still grew a layer would be the more alarming of the two.
 */
export function requiredArmGateIds(arm: Phase7Arm): readonly string[] {
  const ids: string[] = [
    `P7-arm-windows:${arm}`,
    `P7-arm-stat:${arm}`,
    `P7-arm-seed:${arm}`,
    `P7-arm-layers:${arm}`,
    `P7-arm-binds-unchanged:${arm}`,
    `P7-${arm}`,
  ];
  for (const server of PHASE7_SERVER_IDS) {
    ids.push(`P7-arm-inread:${server}:${arm}`);
    ids.push(`P7-arm-catalogue:${server}:${arm}`);
    ids.push(`P7-arm-churn:${server}:${arm}`);
  }
  for (const id of PHASE7_ARM_DETAIL_GATE_IDS[arm]) ids.push(id);
  return Object.freeze(ids);
}

/**
 * The ids a RUN must carry once, outside any arm.
 *
 * THE PLAYBACK IDS ARE PER SERVER AND ARE ADDED BELOW rather than listed, so a server added to
 * `PHASE7_SERVER_IDS` cannot be quietly left out of the playback requirement.
 */
export function requiredRunGateIds(): readonly string[] {
  const ids: string[] = [
    // Stage A — the healthy baseline, with all three attached BEFORE the first mount.
    'P7-A-consumers-pre-attached',
    'P7-A-one-generation',
    'P7-A-entry-is-decodable-video',
    'P7-A-resolver-loopback-only',
    'P7-A-recovery-idle',
    'P7-A-windows',
    'P7-A-stat',
    'P7-A-layers',
    // Stage C — three consumers active on ONE mount and ONE generation, with the overlap observed.
    'P7-C-overlap-three-way-observed',
    'P7-C-concurrent-play-overlapped',
    'P7-C-windows-after',
    // Stage F — the operator workflow, driving the SHIPPED command with media servers attached.
    'P7-F-preflight-idempotent',
    'P7-F-status-truthful',
    'P7-F-upgrade-recorded-rollback-target',
    'P7-F-rollback-returned',
    'P7-F-reset-recovery-idempotent',
    'P7-F-stop-left-the-data',
    // The run-level custody, cleanliness and provider-contact assertions.
    'P7-leak-manifest',
    'P7-leak-manifest-ref-placement',
    'P7-leak-probe-cache',
    'P7-leak-library-state',
    'P7-leak-evidence',
    'P7-resolutions-happened',
    'P7-layers-at-end',
    'P7-host-container-set-unchanged',
    'P7-host-network-set-unchanged',
    'P7-host-volume-set-unchanged',
    'P7-own-mountpoints-removed',
    'P7-own-run-directory-removed',
  ];
  for (const server of PHASE7_SERVER_IDS) {
    ids.push(`P7-A-catalogue:${server}`);
    ids.push(`P7-A-inread:${server}`);
    ids.push(`P7-B-play-start-ms:${server}`);
    ids.push(`P7-B-play-decoded-seconds:${server}`);
    ids.push(`P7-B-seeks:${server}`);
    ids.push(`P7-B-transcode-decoded-seconds:${server}`);
    ids.push(`P7-C-catalogue:${server}`);
    // THE LAST ONE IS THE PRODUCT CLAIM AND NOT A DIAGNOSTIC. After every fault this run injects, each
    // server plays the object again through the bind it has held since before the first mount — without
    // being restarted, re-bound or re-created, which is what makes it a claim about the appliance rather
    // than about how patiently the gate rebuilt its own world.
    ids.push(`P7-D-play-after-recovery:${server}`);
  }
  return Object.freeze(ids);
}

/** Which predeclared threshold a gate id is measured against, or undefined when it carries no number. */
export function phase7BudgetKeyFor(gateId: string): keyof typeof PHASE7_RULES | undefined {
  const bare = gateId.split(':')[0] ?? gateId;
  if (bare === 'P7-B-play-start-ms') return 'PLAY_START_BUDGET_MS';
  if (bare === 'P7-B-play-decoded-seconds') return 'PLAY_DECODED_SECONDS_MIN';
  if (bare === 'P7-B-transcode-decoded-seconds') return 'TRANSCODE_DECODED_SECONDS_MIN';
  if (bare === 'P7-B-seeks') return 'SEEK_COUNT';
  if (bare === 'P7-arm-churn') return 'LIBRARY_CHURN_MAX';
  if (bare === 'P7-arm-windows' || bare === 'P7-A-windows' || bare === 'P7-C-windows-after') {
    return 'OPERATOR_WINDOWS_REQUIRED';
  }
  if (bare === 'P7-arm-layers' || bare === 'P7-A-layers') return 'MOUNT_LAYERS_ABOVE_FLOOR_MAX';
  if (bare === 'P7-layers-at-end') return 'MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END';
  if (bare === 'P7-R1-action-ms' || bare === 'P7-R2-action-ms') return 'RECOVERY_ACTION_BUDGET_MS';
  if (bare === 'P7-R1-ready-ms' || bare === 'P7-R2-ready-ms') return 'RECOVERY_READY_BUDGET_MS';
  if (bare === 'P7-R4-ready-ms') return 'READY_BUDGET_MS';
  if (bare === 'P7-R6-ready-after-reset') return 'READY_BUDGET_MS';
  if (bare === 'P7-R1-attempts' || bare === 'P7-R2-attempts') return 'SINGLE_FLIGHT_ACTIONS_MAX';
  if (bare === 'P7-R1-single-flight' || bare === 'P7-R2-single-flight' || bare === 'P7-R4-single-flight') {
    return 'SINGLE_FLIGHT_ACTIONS_MAX';
  }
  if (bare === 'P7-R3-read-fail-ms') return 'READ_FAIL_BUDGET_MS';
  if (bare === 'P7-R3-refusal-ms') return 'BREAKER_REFUSAL_BUDGET_MS';
  if (bare === 'P7-R3-hold-resolver-requests') return 'HOLD_RESOLVER_REQUESTS_MAX';
  if (bare === 'P7-R3-recovery-ms') return 'OUTAGE_RECOVERY_BUDGET_MS';
  if (bare === 'P7-R3-half-open-probes') return 'HALF_OPEN_PROBES';
  if (bare === 'P7-R6-attempts-spent') return 'RECOVERY_MAX_ATTEMPTS';
  if (bare === 'P7-R6-cooldown-ms') return 'RECOVERY_COOLDOWN_MS';
  return undefined;
}

export interface Phase7ArmRecord {
  readonly index: number;
  readonly arm: string;
}

export interface Phase7Results {
  readonly arms: readonly Phase7ArmRecord[];
  readonly results: readonly GateResult[];
}

/**
 * Everything wrong with a completed run, as sentences.
 *
 * A SKIP IS NEVER A PASS HERE. `GateVerdict` has three values and two of them are not success.
 */
export function phase7ClosureProblems(document: Phase7Results): string[] {
  const problems: string[] = [];

  if (!Array.isArray(document.arms) || !Array.isArray(document.results)) {
    return ['the results document has no arm list or no verdict list, so nothing about it can be judged'];
  }

  if (document.arms.length !== PHASE7_RULES.ARMS_PER_RUN) {
    problems.push(`the run recorded ${document.arms.length} arm(s) against the predeclared `
      + `${PHASE7_RULES.ARMS_PER_RUN}; a run that stopped early is not a run that passed`);
  }

  // THE ARM SET IS COMPARED AS A SEQUENCE, NOT AS A COUNT. Six R1s would clear a count.
  const armsSeen: string[] = [];
  document.arms.forEach((record, index) => {
    const expected = PHASE7_ARMS[index];
    if (record.index !== index + 1) {
      problems.push(`arm ${index + 1} is recorded as arm ${record.index}; the arms are not in order`);
    }
    if (expected !== undefined && record.arm !== expected) {
      problems.push(`arm ${index + 1} ran ${JSON.stringify(record.arm)} where the contract names ${expected}`);
    }
    armsSeen.push(record.arm);
  });
  for (const arm of PHASE7_ARMS) {
    if (!armsSeen.includes(arm)) problems.push(`arm ${arm} was never run, and a missing arm is a failed run`);
  }

  const byId = new Map<string, GateResult>();
  for (const result of document.results) {
    if (result === null || typeof result !== 'object' || typeof result.gate !== 'string') {
      problems.push('a verdict in the results document has no gate id');
      continue;
    }
    // A SECOND VERDICT UNDER ONE ID IS REFUSED RATHER THAN OVERWRITTEN. Two answers to one question means a
    // later phase silently replaced an earlier failure, which is the shape a retry loop produces.
    if (byId.has(result.gate)) {
      problems.push(`${result.gate} carries two verdicts; one id answers one question exactly once`);
    }
    byId.set(result.gate, result);
  }

  const require = (id: string): void => {
    const found = byId.get(id);
    if (found === undefined) {
      problems.push(`${id} is absent: the step that answers it did not run, and an absent measurement is `
        + 'not a passing one');
      return;
    }
    if (found.verdict !== 'pass') {
      problems.push(`${id} is ${found.verdict}`
        + (typeof found.measured === 'number' && typeof found.budget === 'number'
          ? ` (${found.measured} against ${found.budget})` : ''));
    }
  };

  document.arms.forEach((record, index) => {
    const arm = (PHASE7_ARMS[index] ?? record.arm) as Phase7Arm;
    if (PHASE7_ARM_DETAIL_GATE_IDS[arm] === undefined) {
      problems.push(`arm ${record.index} names an arm this contract does not define`);
      return;
    }
    for (const id of requiredArmGateIds(arm)) require(id);
  });
  for (const id of requiredRunGateIds()) require(id);

  // AND EVERY NUMBER WAS COMPARED AGAINST THE THRESHOLD THE CONTRACT NAMES, not against one the run supplied
  // for itself. A verdict recording `measured: 40 budget: 40000` under a budget the module says is 22000 has
  // passed a comparison nobody agreed to.
  for (const [id, result] of byId) {
    const key = phase7BudgetKeyFor(id);
    if (key === undefined) continue;
    const expected = PHASE7_RULES[key] as number;
    if (typeof result.measured !== 'number' || !Number.isFinite(result.measured)) {
      problems.push(`${id} carries no finite measurement, so its verdict is about nothing`);
      continue;
    }
    if (result.budget !== expected) {
      problems.push(`${id} was measured against ${String(result.budget)} where the contract names `
        + `${expected} (${key})`);
    }
  }

  // AND NOTHING ELSE IN THE DOCUMENT MAY HAVE FAILED EITHER. The required set is a floor on what must be
  // present, not a list of the only verdicts that count.
  for (const result of document.results) {
    if (result?.verdict === 'fail') {
      const already = problems.some((problem) => problem.startsWith(`${result.gate} is`));
      if (!already) problems.push(`${result.gate} is fail, and a recorded failure outside the required set `
        + 'is still a failure');
    }
    if (result?.verdict === 'skip') {
      const already = problems.some((problem) => problem.startsWith(`${result.gate} is`));
      if (!already) problems.push(`${result.gate} is skip, and this gate has no optional arms: a skip is a `
        + 'failure');
    }
  }

  return problems;
}
