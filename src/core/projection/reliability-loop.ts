// Projection Phase 3 — the reliability loop's rules, as code rather than as prose.
//
// WHY THIS FILE EXISTS AT ALL. `docs/PROJECTION_PHASE_3_RELIABILITY_LOOP.md` predeclares a cycle count, a
// consecutive-fresh-run rule, six named arms and a budget per arm. A document cannot stop a later run from
// quietly finding one of those inconvenient, and this repository has the failure mode: a threshold fitted to
// an observation, a floor lowered because a run missed it, a gate whose own success became unfailable. So
// every number the contract names is DECIDED here, DERIVED from the product's own constants where a
// derivation exists, and pinned by `test/projection-reliability-loop.ts`.
//
// THE TWO NUMBERS THAT ARE CHOSEN SAY SO IN THEIR OWN COMMENTS. A chosen number presented as a derived one is
// worse than a chosen number, because the next reader cannot tell which is which.
//
// NOTHING HERE IMPORTS A GATE OR TOUCHES A FILESYSTEM. It is pure, so the offline suite runs the same
// arithmetic the gate runs.

import {
  PROJECTIOND_READ_POLICY,
  PROJECTIOND_ADMISSION_LIMITS,
  PROJECTIOND_CIRCUIT_BREAKER,
  PROJECTIOND_ACCESS_RESOLUTION,
  PROJECTION_PHASE_1_BUDGETS,
} from './runtime-contract.js';
import { MEDIA_SERVER_SOAK, type GateResult } from './media-server-dataplane.js';

/**
 * The six arms, in the order the gate runs them, and the order is part of the contract.
 *
 * A2 and A4 and A5's second half all drop the daemon's in-memory access material, which is the only way a
 * resolution can be forced against a source whose lease is still good. They are ordered after A1 so that the
 * cheapest recovery is proved before the expensive ones depend on it.
 */
export const RELIABILITY_LOOP_ARMS = Object.freeze([
  'A1', // graceful daemon restart
  'A2', // daemon SIGKILL, then restart over the corpse it left
  'A3', // the mount taken out from under a living daemon, and auto-remounted
  'A4', // a provider outage that outlasts the circuit breaker's cooldown
  'A5', // credential rotation: invisible while the lease holds, refused then converged once it does not
  'A6', // all three frontends restarted over the same mountpoint
] as const);

export type ReliabilityArm = (typeof RELIABILITY_LOOP_ARMS)[number];

/** What each arm is, in one line, for the report. Never a path, an address or a reference. */
export const RELIABILITY_ARM_TITLES: Readonly<Record<ReliabilityArm, string>> = Object.freeze({
  A1: 'graceful daemon restart',
  A2: 'daemon SIGKILL and restart over the stale mount it left',
  A3: 'the mount taken out from under a living daemon, then auto-remounted',
  A4: 'a sustained provider outage past the breaker cooldown, then recovery',
  A5: 'credential rotation — invisible under a live lease, refused then converged without one',
  A6: 'all three frontends restarted over the same mountpoint',
});

/** The three servers, in the same order and under the same ids the rest of the repository uses. */
export const RELIABILITY_SERVER_IDS = Object.freeze(['emby', 'jellyfin', 'plex'] as const);
export type ReliabilityServerId = (typeof RELIABILITY_SERVER_IDS)[number];

/**
 * The pointer poll interval the gate configures on the daemon, in milliseconds.
 *
 * IT IS HERE RATHER THAN IN THE SHELL because `READY_BUDGET_MS` is derived from it, and a budget derived from
 * a number that lives somewhere else is a budget that silently stops matching its own derivation.
 */
export const RELIABILITY_POLL_INTERVAL_MS = 2_000;

/**
 * Every threshold the contract names.
 *
 * DERIVED MEANS DERIVED. Each entry below either computes from a `runtime-contract.ts` constant or carries a
 * comment saying it was chosen and why nothing derives it.
 */
export const RELIABILITY_LOOP_RULES = Object.freeze({
  /** One cycle per arm. The arm list IS the cycle list; this is not a round number. */
  CYCLES_PER_RUN: RELIABILITY_LOOP_ARMS.length,

  /** The repository's own closure convention. One green run is a coincidence. */
  CONSECUTIVE_FRESH_RUNS: 3,

  /**
   * From a daemon start to a namespace a sibling container can read: the pointer poll plus one read
   * deadline, which are the only two bounded waits on that path.
   */
  READY_BUDGET_MS: RELIABILITY_POLL_INTERVAL_MS + PROJECTIOND_READ_POLICY.READ_DEADLINE_MS,

  /** A read that fails during an outage fails inside the product's own deadline, or the product is wrong. */
  READ_FAIL_BUDGET_MS: PROJECTIOND_READ_POLICY.READ_DEADLINE_MS,

  /**
   * A read refused locally by an open breaker never queues for admission, so it must beat the shortest wait
   * any ADMITTED read could incur. The observed figure is recorded beside this and is expected to be orders
   * of magnitude smaller; the ceiling is the derived one and not the observed one, because fitting a ceiling
   * to a measurement is how this repository has already produced two budgets it had to retire.
   */
  BREAKER_REFUSAL_BUDGET_MS: PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS,

  /** From the release instant to a successful digest-matching read. */
  OUTAGE_RECOVERY_BUDGET_MS:
    PROJECTIOND_CIRCUIT_BREAKER.OPEN_COOLDOWN_MS + PROJECTIOND_READ_POLICY.READ_DEADLINE_MS,

  /** While the breaker is open, zero packets leave the host. */
  HOLD_RESOLVER_REQUESTS_MAX: 0,

  /**
   * How long the outage arm reads against an open breaker before releasing.
   *
   * HALF THE COOLDOWN, AND THE FRACTION IS THE POINT RATHER THAN THE NUMBER. The claim being measured is
   * "zero requests reach the endpoint WHILE THE BREAKER IS OPEN", and the breaker closes on its own after
   * `OPEN_COOLDOWN_MS`. A hold window that could outlast the cooldown would let the half-open probe fire
   * inside the window being measured — one legitimate request, against a ceiling of zero, failing a
   * correct product for doing exactly what the contract says it must. Half is strictly inside by
   * construction and stays so however the cooldown is later changed.
   */
  HOLD_WINDOW_MS: PROJECTIOND_CIRCUIT_BREAKER.OPEN_COOLDOWN_MS / 2,

  /** Half-open lets exactly one request through. Not a fraction, not a burst. */
  HALF_OPEN_PROBES: PROJECTIOND_CIRCUIT_BREAKER.HALF_OPEN_PROBES,

  /**
   * The daemon caches the credential in memory and re-reads the file only when the resolver answers 401/403
   * (`projectiond/internal/source/resolver.go`). One read spends the reload; the next presents the new value.
   * Two is what that mechanism can need at most — a property of the code, not a measurement of a run.
   */
  ROTATION_CONVERGENCE_READS: 1 + PROJECTIOND_READ_POLICY.MAX_ACCESS_REFRESHES_PER_READ,

  /**
   * The refusal half is bounded by the SAME mechanism as the convergence half — one read to be refused, one
   * for the reload to be spent — so it is the same number rather than a second one invented for it.
   *
   * WHAT MAKES IT SAFE IS THAT IT IS STRICTLY UNDER THE BREAKER'S THRESHOLD, and that is asserted rather
   * than eyeballed: `CondSourceAuthRefused` counts toward the breaker and is TERMINAL, so it costs exactly
   * one counted failure per read and no retries within one. A refusal half that needed five reads would be
   * opening the breaker and measuring A4 under A5's name. `ROTATION_REFUSAL_BELOW_BREAKER` below is the
   * check, and `test/projection-reliability-loop.ts` fails if it ever stops holding.
   */
  ROTATION_REFUSAL_READS_MAX: 1 + PROJECTIOND_READ_POLICY.MAX_ACCESS_REFRESHES_PER_READ,

  /** Items added or removed across any arm, on any server. */
  LIBRARY_CHURN_MAX: PROJECTION_PHASE_1_BUDGETS.MAX_LIBRARY_CHURN_ITEMS,

  /** One refresh per read and one per source per cooldown; both are 1 and both are the same ceiling here. */
  RESOLUTIONS_PER_WIRE_READ_MAX: Math.min(
    PROJECTIOND_READ_POLICY.MAX_ACCESS_REFRESHES_PER_READ,
    PROJECTIOND_ACCESS_RESOLUTION.MAX_REFRESHES_PER_SOURCE_PER_COOLDOWN,
  ),

  /** G8's own number, imported rather than restated. */
  PLAY_START_BUDGET_MS: MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS * 1_000,

  /**
   * CHOSEN, WITH BOTH OF ITS BOUNDS NAMED — which is the most that can honestly be said for it.
   *
   * BELOW: the shipped Jellyfin driver's `paced-play` requires at least 30 progress records from the decoder,
   * "roughly one a second". A shorter window would fail that driver's own floor and the failure would be
   * about the window rather than about the product, so thirty seconds is the shortest window in which all
   * three shipped drivers can report at all.
   *
   * ABOVE: §2 of the acceptance plan calls the real-provider corpus a correctness corpus and says it is
   * NEVER a load test. Thirty seconds on each of three servers, on each of six cycles, of each of three runs
   * is 1,620 decoded seconds against a metered account, and that is already the outer edge of what a
   * correctness corpus can be asked for.
   *
   * IT IS NOT G8 AND DOES NOT RE-CLOSE IT. G8's five minutes are closed against the fake corpus, three
   * times, on this same host.
   */
  PLAY_DECODED_SECONDS_MIN: 30,

  /** The operator records these outside the mount before any run; the gate compares, it does not compute. */
  OPERATOR_WINDOWS_REQUIRED: 4,
} as const);

/**
 * A5's refusal half must not be able to open the breaker A4 is about.
 *
 * IT IS A DERIVED FACT, NOT A COMMENT. `CondSourceAuthRefused` is terminal, so one refused read costs exactly
 * one counted failure; the arm is bounded at `ROTATION_REFUSAL_READS_MAX` of them, and that has to stay under
 * `FAILURE_THRESHOLD` however either number is later changed.
 */
export const ROTATION_REFUSAL_BELOW_BREAKER =
  RELIABILITY_LOOP_RULES.ROTATION_REFUSAL_READS_MAX < PROJECTIOND_CIRCUIT_BREAKER.FAILURE_THRESHOLD;

/**
 * The nonclaims, printed by the gate at the end of every run.
 *
 * THEY ARE PRINTED BY THE PASSING PATH ON PURPOSE. A list of things a gate does not prove, kept in a document
 * nobody opens after a green run, is a list that stops being read exactly when it matters.
 */
export const RELIABILITY_LOOP_NONCLAIMS: readonly string[] = Object.freeze([
  'This is not a load test and no figure here is a performance claim. One object, four 64 KiB windows and '
  + 'thirty decoded seconds per server per cycle.',
  'It re-closes none of G7-G13, G18 or G22. The ~50-entry corpus is not here, so nothing about scan cost, '
  + 'amplification, concurrency budgets or re-scan churn AT CORPUS SCALE is measured.',
  'It declares no winner between frontends and is not a bake-off. Phase 2 declared none and ADR-002 is '
  + 'untouched.',
  'The continuous three-way overlap is RECORDED in measurement mode, against no floor. What is REQUIRED is '
  + 'that all three were observed scanning and that at least one fully attributed three-way sample exists.',
  'One object is one object. Every property is shown for this provider and this shape of object.',
  'Provider bytes are NOT counted: there is no counter on the far side of a real CDN and the daemon '
  + 'publishes no cumulative provider-byte figure. What is bounded is what the gate itself asks for.',
  'No 429 was provoked and none is asserted.',
]);

// ---------------------------------------------------------------------------------------------------------
// The closure check
// ---------------------------------------------------------------------------------------------------------

/**
 * The gate ids one cycle MUST carry, all of them terminal and all of them passing.
 *
 * WHY THE SET IS COMPUTED RATHER THAN LISTED. "No skipped arm can count as success" is only enforceable if
 * something knows what a complete cycle looks like without being told by the run that is being judged. A run
 * that never executed a phase writes no id for it, and the absence is what fails — which is the opposite of
 * the shape this repository keeps finding, where a phase that did not run left nothing behind and the gate
 * exited 0.
 */
export function requiredCycleGateIds(cycle: number, arm: ReliabilityArm): readonly string[] {
  const ids: string[] = [
    `RL-B-stat:c${cycle}`,
    `RL-B-windows:c${cycle}`,
    `RL-B-seed:c${cycle}`,
    `RL-F-${arm}:c${cycle}`,
    `RL-R-ready-ms:c${cycle}`,
    `RL-R-stat:c${cycle}`,
    `RL-R-windows:c${cycle}`,
    `RL-R-seed:c${cycle}`,
  ];
  for (const server of RELIABILITY_SERVER_IDS) {
    ids.push(`RL-O-catalogue:${server}:c${cycle}`);
    ids.push(`RL-O-play-start-ms:${server}:c${cycle}`);
    ids.push(`RL-O-play-decoded-seconds:${server}:c${cycle}`);
    ids.push(`RL-B-inread:${server}:c${cycle}`);
    ids.push(`RL-R-inread:${server}:c${cycle}`);
    ids.push(`RL-R-catalogue:${server}:c${cycle}`);
    ids.push(`RL-R-churn:${server}:c${cycle}`);
  }
  // THE ARM'S OWN EVIDENCE, WHICH IS NOT THE SAME SHAPE FOR ALL SIX. `RL-F-<arm>` above is the summary
  // verdict; these are the measurements it summarises, and requiring them by name is what stops an arm from
  // reporting a clean summary over a phase that never executed its middle.
  for (const id of ARM_DETAIL_GATE_IDS[arm]) ids.push(`${id}:c${cycle}`);
  return Object.freeze(ids);
}

/**
 * The per-arm measurements, without the cycle suffix.
 *
 * A3's three-frontend read is the one this whole tranche exists for: Phase 2's `--auto-remount` recovered the
 * namespace for the daemon and for nobody else, and only a consumer reading through its OWN bind afterwards
 * can tell those two apart.
 */
export const ARM_DETAIL_GATE_IDS: Readonly<Record<ReliabilityArm, readonly string[]>> = Object.freeze({
  A1: Object.freeze(['RL-F-A1-namespace-went-away', 'RL-F-A1-ready-ms']),
  A2: Object.freeze(['RL-F-A2-corpse-was-stale', 'RL-F-A2-probe-named-the-corpse', 'RL-F-A2-ready-ms']),
  A3: Object.freeze(['RL-F-A3-serve-death-observed', 'RL-F-A3-remounted-in-place',
    'RL-F-A3-identity-unchanged', 'RL-F-A3-frontends-read-after-remount']),
  A4: Object.freeze(['RL-F-A4-read-fail-ms', 'RL-F-A4-breaker-opened', 'RL-F-A4-refusal-ms',
    'RL-F-A4-hold-resolver-requests', 'RL-F-A4-recovery-ms', 'RL-F-A4-half-open-probes']),
  A5: Object.freeze(['RL-F-A5-invisible-under-live-lease', 'RL-F-A5-refusal-observed',
    'RL-F-A5-refusal-reads', 'RL-F-A5-convergence-reads', 'RL-F-A5-breaker-stayed-closed']),
  A6: Object.freeze(['RL-F-A6-frontends-came-back', 'RL-F-A6-identities-unchanged']),
});

/**
 * Which predeclared threshold a gate id is measured against, or undefined when it carries no number.
 *
 * WHY THE CLOSURE CHECK RE-DERIVES IT. A gate records `measured` AND `budget` side by side, and a gate that
 * wrote the wrong budget beside a correct measurement would pass its own comparison while asserting nothing
 * the contract names. So `close` compares the recorded budget against this table, and a disagreement is a
 * failure of the RUN rather than a note about it.
 */
export function budgetKeyFor(gateId: string): keyof typeof RELIABILITY_LOOP_RULES | undefined {
  const bare = gateId.split(':c')[0] ?? gateId;
  if (bare === 'RL-R-ready-ms' || bare === 'RL-F-A1-ready-ms' || bare === 'RL-F-A2-ready-ms') {
    return 'READY_BUDGET_MS';
  }
  if (bare.startsWith('RL-O-play-start-ms')) return 'PLAY_START_BUDGET_MS';
  if (bare.startsWith('RL-O-play-decoded-seconds')) return 'PLAY_DECODED_SECONDS_MIN';
  if (bare.startsWith('RL-R-churn')) return 'LIBRARY_CHURN_MAX';
  if (bare === 'RL-F-A4-read-fail-ms') return 'READ_FAIL_BUDGET_MS';
  if (bare === 'RL-F-A4-refusal-ms') return 'BREAKER_REFUSAL_BUDGET_MS';
  if (bare === 'RL-F-A4-hold-resolver-requests') return 'HOLD_RESOLVER_REQUESTS_MAX';
  if (bare === 'RL-F-A4-recovery-ms') return 'OUTAGE_RECOVERY_BUDGET_MS';
  if (bare === 'RL-F-A4-half-open-probes') return 'HALF_OPEN_PROBES';
  if (bare === 'RL-F-A5-refusal-reads') return 'ROTATION_REFUSAL_READS_MAX';
  if (bare === 'RL-F-A5-convergence-reads') return 'ROTATION_CONVERGENCE_READS';
  if (bare === 'RL-B-windows' || bare === 'RL-R-windows') return 'OPERATOR_WINDOWS_REQUIRED';
  return undefined;
}

/** The ids a RUN must carry once, outside any cycle. */
export const REQUIRED_RUN_GATE_IDS: readonly string[] = Object.freeze([
  'RL-entry-is-decodable-video',
  'RL-resolver-loopback-only',
  'RL-overlap-three-way-observed',
  'RL-leak-manifest',
  'RL-leak-probe-cache',
  'RL-leak-library-state',
  'RL-leak-evidence',
  'RL-resolutions-happened',
  'RL-host-container-set-unchanged',
  'RL-host-network-set-unchanged',
  'RL-host-volume-set-unchanged',
  'RL-own-mountpoints-removed',
  'RL-own-run-directory-removed',
]);

export interface ReliabilityCycleRecord {
  readonly cycle: number;
  readonly arm: string;
}

export interface ReliabilityResults {
  readonly cycles: readonly ReliabilityCycleRecord[];
  readonly results: readonly GateResult[];
}

/**
 * Everything wrong with a completed run, as sentences.
 *
 * A SKIP IS NEVER A PASS HERE, AND THAT IS THE HEADLINE. `GateVerdict` has three values and two of them are
 * not success. A gate that treated `skip` as "nothing to see" would let an arm that could not run report a
 * clean cycle, which is exactly the accounting `docs/PROJECTION_PHASE_2_MOUNT_HARDENING.md` §7 calls the one
 * defect wearing three hats.
 */
export function reliabilityClosureProblems(document: ReliabilityResults): string[] {
  const problems: string[] = [];
  const expectedCycles = RELIABILITY_LOOP_RULES.CYCLES_PER_RUN;

  if (!Array.isArray(document.cycles) || !Array.isArray(document.results)) {
    return ['the results document has no cycle list or no verdict list, so nothing about it can be judged'];
  }

  if (document.cycles.length !== expectedCycles) {
    problems.push(`the run recorded ${document.cycles.length} cycle(s) against the predeclared `
      + `${expectedCycles}; a run that stopped early is not a run that passed`);
  }

  // THE ARM SET IS COMPARED AS A SEQUENCE, NOT AS A COUNT. Six cycles all running A1 would clear a count.
  const armsSeen: string[] = [];
  document.cycles.forEach((record, index) => {
    const expectedArm = RELIABILITY_LOOP_ARMS[index];
    if (record.cycle !== index + 1) {
      problems.push(`cycle ${index + 1} is recorded as cycle ${record.cycle}; the cycles are not in order`);
    }
    if (expectedArm !== undefined && record.arm !== expectedArm) {
      problems.push(`cycle ${index + 1} ran arm ${JSON.stringify(record.arm)} where the contract names `
        + `${expectedArm}`);
    }
    armsSeen.push(record.arm);
  });
  for (const arm of RELIABILITY_LOOP_ARMS) {
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

  document.cycles.forEach((record, index) => {
    const arm = (RELIABILITY_LOOP_ARMS[index] ?? record.arm) as ReliabilityArm;
    if (ARM_DETAIL_GATE_IDS[arm] === undefined) {
      problems.push(`cycle ${record.cycle} names an arm this contract does not define`);
      return;
    }
    for (const id of requiredCycleGateIds(record.cycle, arm)) require(id);
  });
  for (const id of REQUIRED_RUN_GATE_IDS) require(id);

  // AND EVERY NUMBER WAS COMPARED AGAINST THE THRESHOLD THE CONTRACT NAMES, not against one the run supplied
  // for itself. A verdict recording `measured: 40 budget: 40000` under a budget the module says is 22000 has
  // passed a comparison nobody agreed to.
  for (const [id, result] of byId) {
    const key = budgetKeyFor(id);
    if (key === undefined) continue;
    const expected = RELIABILITY_LOOP_RULES[key] as number;
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
  // present, not a list of the only verdicts that count: a gate is free to record more, and a recorded
  // failure outside the set is still a failure.
  for (const result of document.results) {
    if (result?.verdict === 'fail') {
      const already = problems.some((problem) => problem.startsWith(`${result.gate} is`));
      if (!already) problems.push(`${result.gate} is fail, and a recorded failure outside the required set `
        + 'is still a failure');
    }
  }

  return problems;
}
