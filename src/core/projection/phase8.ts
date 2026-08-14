// Projection Phase 8 — the operator soak's rules, as code rather than as prose.
//
// WHAT PHASE 8 IS, IN ONE SENTENCE. Phase 7 proved the appliance survives six deliberate faults with three
// real media servers attached and playing; Phase 8 asks whether it survives being USED — the same cache,
// ledger, libraries, containers, binds and mount point, cycle after cycle, with nothing recreated between
// them.
//
// WHY THAT IS NOT IMPLIED BY PHASE 7, AND ITS OWN §5 IS THE ARGUMENT. Every Phase 7 run is FRESH by design —
// a new database, a new manifest, a new cache, new media-server configuration directories, a mount point that
// has never been mounted — because "the question is whether the appliance survives a fault FROM A CLEAN
// START". An operator never gets a clean start. Phase 7 §12.4 ships five rough edges and three of them are
// states reached by REPETITION rather than by injection.
//
// THE INVERSION IS THE WHOLE TRANCHE AND IT IS ENCODED HERE. The SOAK is fresh; the CYCLES inside it are
// deliberately NOT, and a cycle that finds its cache, ledger, libraries or consumers new is a FAILURE rather
// than a tidier starting point.
//
// EVERY NUMBER HERE IS IMPORTED FROM A CLOSED TRANCHE'S MODULE EXCEPT THE THREE §4 NAMES AS NEW. Two
// derivations of one budget are two budgets the moment either is edited, which is the rule Phase 7 applied to
// Phase 3 and this file applies to Phase 7. `test/projection-phase8.ts` fails if any of it drifts.
//
// NOTHING HERE IMPORTS A GATE OR TOUCHES A FILESYSTEM.

import { PROJECTION_PHASE_1_BUDGETS } from './runtime-contract.js';
import { MEDIA_SERVER_SOAK, type GateResult } from './media-server-dataplane.js';
import { RELIABILITY_LOOP_RULES, RELIABILITY_POLL_INTERVAL_MS } from './reliability-loop.js';
import { PHASE7_RULES, PHASE7_SERVER_IDS } from './phase7.js';

/**
 * The two IMPORTED constants the gate needs that are not thresholds, kept out of `PHASE8_RULES` on purpose.
 *
 * NEITHER IS A §4 THRESHOLD AND NEITHER MAY BECOME ONE BY BEING WRITTEN DOWN HERE. §4's table is the list of
 * numbers a VERDICT is measured against, and `phase8BudgetKeyFor` returns nothing for either of these: the
 * poll interval is the flag the daemon is configured with, and the read-fail budget is how long the gate
 * waits for an in-container read before it stops waiting. Putting them in `PHASE8_RULES` would have added two
 * rows to a table the contract predeclared and closed, which is the one edit §4 forbids.
 *
 * THEY ARE HERE BECAUSE THE GATE READ THEM AND NOTHING PUBLISHED THEM. Phase 7 publishes its own poll interval
 * the same way and for the same reason; this tranche's CLI was written from that one and dropped both, and
 * under `set -u` the gate exits at the line that reads the first of them — during setup, before a single
 * cycle. `src/core/projection/phase8-gate-audit.ts` is the pin that now refuses that.
 */
export const PHASE8_POLL_INTERVAL_MS = RELIABILITY_POLL_INTERVAL_MS;
export const PHASE8_READ_FAIL_BUDGET_MS = RELIABILITY_LOOP_RULES.READ_FAIL_BUDGET_MS;

/**
 * The ten steps of one operator cycle, in the order the gate runs them, and the order is part of the
 * contract.
 *
 * WHY THIS ORDER. It is the order an operator walks: ask whether it is safe (S1), install and start and check
 * (S2), confirm the thing they installed it for still works (S3, S4), meet the accident they are most likely
 * to cause (S5), look at what that left behind (S6), stop and start it the way they always do (S7), reason
 * about the recovery state (S8), upgrade and change their mind (S9), and leave the host as they found it
 * (S10). Nothing here is an injection except S5, and S5 is the one fault Phase 7 §12.3 calls the single most
 * likely operator-side accident on this appliance.
 */
export const PHASE8_STEPS = Object.freeze([
  'S1', // preflight, against a mount point that has been used before
  'S2', // install / start / start again / status — idempotent WHILE CONSUMERS ARE READING
  'S3', // all three consumers read the four approved windows concurrently, in their own containers
  'S4', // useful playback: a paced direct play and a forced transcode per server
  'S5', // one safe automatic recovery — Phase 7 R1's injector, with the consumers still attached
  'S6', // the mount-layer count, above the floor taken before the FIRST cycle's first mount
  'S7', // stop / start, with the three servers untouched
  'S8', // recovery state and reset truth, read from the durable ledger and the shipped surface
  'S9', // upgrade and rollback: the target recorded before anything changes, and honoured
  'S10', // cleanup accounting: the host's sets, and this cycle's own transient resources
] as const);

export type Phase8Step = (typeof PHASE8_STEPS)[number];

/** What each step is, in one line, for the report. Never a path, an address or a reference. */
export const PHASE8_STEP_TITLES: Readonly<Record<Phase8Step, string>> = Object.freeze({
  S1: 'preflight, asked of a mount point that has been used before rather than of a clean one',
  S2: 'install, start, start again and status — idempotent while three media servers are reading',
  S3: 'all three consumers reading the four approved windows at once, in their own containers as their own uid',
  S4: 'a paced direct play and a forced transcode per server, at the durations Phase 1 already measured',
  S5: 'one safe automatic recovery from the mount being taken out from under a living daemon',
  S6: 'the mount-layer count, above the floor taken before the FIRST cycle mounted anything',
  S7: 'stop and start, with the three servers never restarted, re-bound or re-created',
  S8: 'the recovery state and the reset, read from the durable ledger rather than inferred',
  S9: 'upgrade records a rollback target BEFORE it changes anything, and rollback honours it',
  S10: 'the host as it was found, asserted rather than reported',
});

/** The three real media servers, and the ids are Phase 7's own so no report can disagree with another. */
export const PHASE8_SERVER_IDS = PHASE7_SERVER_IDS;

/**
 * The predeclared thresholds.
 *
 * THREE ARE NEW AND EVERY OTHER ONE IS IMPORTED, which is the discipline Phase 7 applied to Phase 3. The new
 * ones are the two this tranche exists to measure — a consumer that was restarted and a human that had to
 * intervene — and the cycle count, which is the repetition convention every tranche here closes on applied to
 * cycles instead of runs.
 */
export const PHASE8_RULES = Object.freeze({
  /** NEW. Three cycles inside one soak. §5 of the contract is the reasoning. */
  CYCLES_PER_SOAK: 3,
  /** NEW, AND THE ONE THIS TRANCHE ADDS. Counted across the WHOLE soak, never per cycle. */
  CONSUMER_RESTARTS_MAX: 0,
  /**
   * NEW. Anything a human would have to do between two declared cycles for the next one to work.
   *
   * A SOAK THAT NEEDS ONE HAS NOT SOAKED, which is why this is a threshold rather than a note: an appliance
   * that needs a nudge every third day is one an operator cannot leave alone, and "it only needed a small
   * one" is exactly the sentence a number like this exists to refuse.
   */
  OPERATOR_INTERVENTIONS_MAX: 0,

  /** IMPORTED from Phase 3, through Phase 7, which imported it first. */
  CONSECUTIVE_FRESH_SOAKS: RELIABILITY_LOOP_RULES.CONSECUTIVE_FRESH_RUNS,
  OPERATOR_WINDOWS_REQUIRED: RELIABILITY_LOOP_RULES.OPERATOR_WINDOWS_REQUIRED,
  READY_BUDGET_MS: RELIABILITY_LOOP_RULES.READY_BUDGET_MS,

  /** IMPORTED from Phase 1's own media-server soak, unchanged from Phase 7. */
  PLAY_START_BUDGET_MS: MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS * 1_000,
  PLAY_DECODED_SECONDS_MIN: MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS,
  TRANSCODE_DECODED_SECONDS_MIN: MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS,
  SEEK_COUNT: MEDIA_SERVER_SOAK.SEEK_COUNT,

  /** IMPORTED from Phase 1's budgets. */
  LIBRARY_CHURN_MAX: PROJECTION_PHASE_1_BUDGETS.MAX_LIBRARY_CHURN_ITEMS,

  /** IMPORTED from Phase 7 §4, which derives all four from Phase 6's own constants. */
  RECOVERY_ACTION_BUDGET_MS: PHASE7_RULES.RECOVERY_ACTION_BUDGET_MS,
  RECOVERY_READY_BUDGET_MS: PHASE7_RULES.RECOVERY_READY_BUDGET_MS,
  SINGLE_FLIGHT_ACTIONS_MAX: PHASE7_RULES.SINGLE_FLIGHT_ACTIONS_MAX,
  MOUNT_LAYERS_ABOVE_FLOOR_MAX: PHASE7_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX,
  MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END: PHASE7_RULES.MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END,
} as const);

/**
 * The freshness inversion, as a property rather than as prose.
 *
 * IT IS EXPORTED SO A TEST CAN EXECUTE IT rather than read the contract and agree with itself. A soak is
 * fresh; a cycle inside it is not; and the second and third cycles must inherit what the first built.
 */
export const THE_SOAK_IS_FRESH_AND_THE_CYCLES_ARE_NOT =
  PHASE8_RULES.CYCLES_PER_SOAK > 1 && PHASE8_RULES.CONSUMER_RESTARTS_MAX === 0;

/**
 * The things a cycle after the first must find UNCHANGED, named so a gate cannot quietly shorten the list.
 *
 * EACH ONE IS SOMETHING PHASE 7 RECREATES BETWEEN RUNS ON PURPOSE, and recreating any of them here would turn
 * a soak back into three Phase 7 runs with a different name on the log.
 */
export const PHASE8_INHERITED_BETWEEN_CYCLES: readonly string[] = Object.freeze([
  'the probe cache directory',
  'the durable recovery ledger',
  'the manifest directory and its generation',
  "the three media servers' configuration directories",
  'the three media-server container ids and their binds',
  'the mount point, which has been mounted before',
]);

/** What this tranche refuses to claim. Every one is a sentence, and §10 of the contract carries all of them. */
export const PHASE8_NONCLAIMS: readonly string[] = Object.freeze([
  // THE PROVIDER IS NOT NAMED HERE AND THAT IS A BOUNDARY RATHER THAN A STYLE. The adapter-boundary suite
  // keeps an explicit allowlist of the files that may know which provider this is, and a file arrives on it
  // deliberately or not at all; a contract module has no reason to be one of them. It scans case-insensitively
  // for the name, so even a comment about the boundary would put this file on the wrong side of it. Phase 7s
  // own nonclaim list says the same thing the same way.
  'It adds no provider. One provider is one provider, and Real-Debrid and Usenet have named contracts '
    + 'rather than support.',
  'It is one host. Three green soaks on a host that is not this one close nothing at all.',
  'It is not an uptime, availability or endurance claim. Three cycles is three cycles, not a week.',
  'It is not a load test and no figure here is a performance claim.',
  'It closes no G-number and re-closes nothing in Phases 1-7.',
  'It does not relabel Phase 7 evidence. Every run in that record stays attributed to the candidate that '
    + 'produced it.',
  'It does not fix Phase 7 rough edges. Its own section 12.4 still ships.',
  'Per-server provider attribution is impossible with one shared daemon and is not claimed.',
]);

/** The per-step measurements, without the cycle suffix. */
export const PHASE8_STEP_DETAIL_GATE_IDS: Readonly<Record<Phase8Step, readonly string[]>> = Object.freeze({
  S1: Object.freeze(['P8-S1-preflight-honest']),
  S2: Object.freeze(['P8-S2-install-idempotent', 'P8-S2-start-idempotent', 'P8-S2-status-truthful']),
  S3: Object.freeze(['P8-S3-windows', 'P8-S3-concurrent']),
  S4: Object.freeze(['P8-S4-play-decoded-seconds', 'P8-S4-transcode-decoded-seconds', 'P8-S4-seeks']),
  S5: Object.freeze([
    'P8-S5-fault-took-the-mount', 'P8-S5-action-ms', 'P8-S5-ready-ms', 'P8-S5-single-flight',
    'P8-S5-reason',
  ]),
  S6: Object.freeze(['P8-S6-layers']),
  S7: Object.freeze(['P8-S7-stop-left-no-layer', 'P8-S7-started-again', 'P8-S7-consumers-untouched']),
  S8: Object.freeze(['P8-S8-ledger-truthful', 'P8-S8-reset-cleared-it']),
  S9: Object.freeze(['P8-S9-upgrade-recorded-rollback-target', 'P8-S9-rollback-returned']),
  S10: Object.freeze(['P8-S10-sets-identical', 'P8-S10-no-operator-intervention']),
});

/**
 * The ids every cycle carries, whatever step they belong to.
 *
 * THE CONSUMER AND WINDOW CHECKS ARE HERE AND NOT IN THE PER-STEP TABLE, because "can the operator's own
 * servers still see it" is a question every cycle has to answer and not one a step owns.
 */
export function requiredCycleGateIds(cycle: number): readonly string[] {
  const suffix = `C${cycle}`;
  const ids: string[] = [
    `P8-cycle-inherited:${suffix}`,
    `P8-cycle-windows:${suffix}`,
    `P8-cycle-layers:${suffix}`,
    `P8-cycle-binds-unchanged:${suffix}`,
    `P8-cycle:${suffix}`,
  ];
  for (const server of PHASE8_SERVER_IDS) {
    ids.push(`P8-cycle-inread:${server}:${suffix}`);
    ids.push(`P8-cycle-churn:${server}:${suffix}`);
  }
  for (const step of PHASE8_STEPS) {
    for (const id of PHASE8_STEP_DETAIL_GATE_IDS[step]) {
      if (id === 'P8-S4-play-decoded-seconds' || id === 'P8-S4-transcode-decoded-seconds'
        || id === 'P8-S4-seeks' || id === 'P8-S3-windows') {
        for (const server of PHASE8_SERVER_IDS) ids.push(`${id}:${server}:${suffix}`);
        continue;
      }
      ids.push(`${id}:${suffix}`);
    }
  }
  return Object.freeze(ids);
}

/** The ids the SOAK carries once, rather than per cycle. */
export function requiredSoakGateIds(): readonly string[] {
  return Object.freeze([
    'P8-consumers-pre-attached',
    'P8-consumers-never-touched',
    'P8-layers-at-end',
    'P8-own-mountpoints-removed',
    // THE HOST SETS ARE THREE IDS AND NOT ONE, because a boolean over three comparisons cannot say
    // WHICH set moved, and "the host is not as it was found" is the one verdict an operator has to act on.
    'P8-host-container-set-unchanged',
    'P8-host-network-set-unchanged',
    'P8-host-volume-set-unchanged',
    'P8-leak-evidence',
    'P8-leak-manifest',
    'P8-leak-library-state',
  ]);
}

/** Which predeclared threshold a gate id is measured against, or undefined when it carries no number. */
export function phase8BudgetKeyFor(gateId: string): keyof typeof PHASE8_RULES | undefined {
  const bare = gateId.split(':')[0] ?? gateId;
  if (bare === 'P8-S4-play-decoded-seconds') return 'PLAY_DECODED_SECONDS_MIN';
  if (bare === 'P8-S4-transcode-decoded-seconds') return 'TRANSCODE_DECODED_SECONDS_MIN';
  if (bare === 'P8-S4-seeks') return 'SEEK_COUNT';
  if (bare === 'P8-S3-windows' || bare === 'P8-cycle-windows') return 'OPERATOR_WINDOWS_REQUIRED';
  if (bare === 'P8-cycle-churn') return 'LIBRARY_CHURN_MAX';
  if (bare === 'P8-cycle-layers' || bare === 'P8-S6-layers') return 'MOUNT_LAYERS_ABOVE_FLOOR_MAX';
  if (bare === 'P8-layers-at-end') return 'MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END';
  if (bare === 'P8-S5-action-ms') return 'RECOVERY_ACTION_BUDGET_MS';
  if (bare === 'P8-S5-ready-ms') return 'RECOVERY_READY_BUDGET_MS';
  if (bare === 'P8-S5-single-flight') return 'SINGLE_FLIGHT_ACTIONS_MAX';
  if (bare === 'P8-consumers-never-touched') return 'CONSUMER_RESTARTS_MAX';
  if (bare === 'P8-S10-no-operator-intervention') return 'OPERATOR_INTERVENTIONS_MAX';
  return undefined;
}

export interface Phase8CycleRecord {
  readonly index: number;
  readonly cycle: number;
}

export interface Phase8Results {
  readonly cycles: readonly Phase8CycleRecord[];
  readonly results: readonly GateResult[];
}

/**
 * Everything wrong with a completed soak, as sentences.
 *
 * A SKIP IS NEVER A PASS HERE, and a cycle that did not run is not a cycle that passed. It is Phase 7's own
 * closure check with the arm loop replaced by a cycle loop, deliberately, so that two tranches cannot disagree
 * about what "present, terminal and passing" means.
 */
export function phase8ClosureProblems(document: Phase8Results): string[] {
  const problems: string[] = [];

  if (!Array.isArray(document.cycles) || !Array.isArray(document.results)) {
    return ['the results document has no cycle list or no verdict list, so nothing about it can be judged'];
  }

  if (document.cycles.length !== PHASE8_RULES.CYCLES_PER_SOAK) {
    problems.push(`the soak recorded ${document.cycles.length} cycle(s) against the predeclared `
      + `${PHASE8_RULES.CYCLES_PER_SOAK}; a soak that stopped early is not a soak that passed`);
  }

  document.cycles.forEach((record, index) => {
    if (record.index !== index + 1) {
      problems.push(`cycle ${index + 1} is recorded as cycle ${record.index}; the cycles are not in order`);
    }
    if (record.cycle !== index + 1) {
      problems.push(`cycle ${index + 1} names itself ${record.cycle}`);
    }
  });

  const byId = new Map<string, GateResult>();
  for (const result of document.results) {
    if (result === null || typeof result !== 'object' || typeof result.gate !== 'string') {
      problems.push('a verdict in the results document has no gate id');
      continue;
    }
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

  for (let cycle = 1; cycle <= PHASE8_RULES.CYCLES_PER_SOAK; cycle += 1) {
    for (const id of requiredCycleGateIds(cycle)) require(id);
  }
  for (const id of requiredSoakGateIds()) require(id);

  // AND EVERY NUMBER WAS COMPARED AGAINST THE THRESHOLD THE CONTRACT NAMES, not against one the soak supplied
  // for itself.
  for (const [id, result] of byId) {
    const key = phase8BudgetKeyFor(id);
    if (key === undefined) continue;
    const expected = PHASE8_RULES[key] as number;
    if (typeof result.measured !== 'number' || !Number.isFinite(result.measured)) {
      problems.push(`${id} carries no finite measurement, so its verdict is about nothing`);
      continue;
    }
    if (result.budget !== expected) {
      problems.push(`${id} was measured against ${String(result.budget)} where the contract names `
        + `${expected} (${key})`);
    }
  }

  for (const result of document.results) {
    if (result?.verdict === 'fail') {
      const already = problems.some((problem) => problem.startsWith(`${result.gate} is`));
      if (!already) problems.push(`${result.gate} is fail, and a recorded failure outside the required set `
        + 'is still a failure');
    }
    if (result?.verdict === 'skip') {
      const already = problems.some((problem) => problem.startsWith(`${result.gate} is`));
      if (!already) problems.push(`${result.gate} is skip, and this gate has no optional steps: a skip is a `
        + 'failure');
    }
  }

  return problems;
}
