import { PHASE9_RULES } from './phase9.js';
import { PHASE10_RULES } from './phase10.js';
import { PHASE7_SERVER_IDS } from './phase7.js';

// Projection Phase 11 — the tranche's rules, as code rather than as prose.
//
// WHAT PHASE 11 IS, IN ONE SENTENCE. Phase 9 gave the namespace the ability to hold a file a Usenet worker
// produced beside an object a provider serves by range; Phase 10 gave an operator a way to put either kind in
// and a way to be told when the namespace and the disk stopped agreeing; Phase 11 asks whether the two halves
// SURVIVE EACH OTHER under one mount — whether each is readable for what it is, and whether a failure of
// either moves anything at all about the other.
//
// WHAT THIS MODULE IS FOR. Four things a gate script gets wrong on its own.
//
// FIRST, THE CLOSURE RULE HAS TWO TIERS AND THEY MAY NOT BE AVERAGED. Phase 10 §8.1 authorised exactly one
// kind of Phase 11 closure and forbade the other: a tier-one GO is a GO on the INSTRUMENT. `PHASE11_TIER`
// splits the fourteen claims and `phase11ClosureProblems` REFUSES a tier-two verdict that carries `fake:
// true` — the same shape of refusal `phase9ClosureProblems` makes about a rehearsal verdict on a
// provider-required claim, for the same reason.
//
// SECOND, EVERY THRESHOLD IS IMPORTED OR IS NAMED AS NEW. Six come from Phase 10 and two from Phase 9, read
// from those modules rather than restated, so a number cannot be re-derived here and drift from the one the
// product is built on. Three are NEW, and each is new because no earlier tranche could have measured it.
//
// THIRD, THE SIX ARMS ARE PREDECLARED. A gate that chose its own arms at run time would be a gate whose green
// run is a statement about the arms it felt like running, and `UNREACHED_ARMS_MAX = 0` would have no
// denominator. §5.4 fixes them before the gate exists, and this list is that fixing.
//
// FOURTH, REACHED IS NOT PASSED. `phase11UnreachedArms` is the whole of P11-M6's measurement, and it is a
// function rather than a constant because Phase 10's own independent audit found `HAND_RUN=0` asserted to be
// zero by a script no line of which could move it. A number a run cannot fail to meet is not a measurement.
//
// NOTHING HERE IMPORTS A GATE, TOUCHES A FILESYSTEM OR CONTACTS ANYTHING.

/**
 * The thresholds.
 *
 * THREE ARE NEW AND EVERY OTHER ONE IS IMPORTED, read from the module of the tranche it came from. The three
 * new ones are the three things this tranche exists to establish and that no earlier tranche could have
 * measured, because no earlier tranche composed the two sources under one mount: how many fields of one
 * source's entry a failure of the OTHER source may move, how many arms a gate may declare and not reach, and
 * how many tier-two ids a fake run may emit. All three are ZERO and all three are the whole point.
 */
export const PHASE11_RULES = Object.freeze({
  /**
   * NEW. §1's question as a number. A failure injected into one source may move ZERO recorded fields of the
   * other source's entry — not its path, its version, its size, its mtime or its locator.
   */
  CROSS_SOURCE_FIELDS_DISTURBED_MAX: 0,
  /**
   * NEW. Phase 10 §8.1 authorises a tier-one GO only if the gate "reached every arm in fake mode". An arm
   * nobody reached is Phase 8's defect #11 — a function defined and never called, six hours in — and this is
   * the number that makes the authorised sentence checkable rather than quotable.
   */
  UNREACHED_ARMS_MAX: 0,
  /** NEW. §4's third hard refusal as a number a run records, and the multiset the gate audit checks. */
  TIER_TWO_IDS_EMITTABLE_BY_A_FAKE_RUN: 0,

  /** IMPORTED from Phase 10, which imported it from Phase 9, from Phase 8, from Phase 3. */
  CONSECUTIVE_FRESH_RUNS: PHASE10_RULES.CONSECUTIVE_FRESH_RUNS,
  /** IMPORTED. A run that needed a human between two of its parts has not run. */
  OPERATOR_INTERVENTIONS_MAX: PHASE10_RULES.OPERATOR_INTERVENTIONS_MAX,
  /** IMPORTED. Cleanup leaves zero phase-owned containers, networks and volumes. */
  RESIDUE_MAX: PHASE10_RULES.RESIDUE_MAX,
  /** IMPORTED. P11-M5 asks Phase 10's P10-4 question of a MIXED path rather than a single-source one. */
  HAND_RUN_COMMANDS_MAX: PHASE10_RULES.HAND_RUN_COMMANDS_MAX,
  /** IMPORTED. A report may not move one byte of the published generation, on either half. */
  GENERATION_BYTES_CHANGED_BY_REPORT_MAX: PHASE10_RULES.GENERATION_BYTES_CHANGED_BY_REPORT_MAX,
  /** IMPORTED. The guard D10.1 put on the real admission path still runs on this tranche's admissions. */
  ADMISSIONS_WITHOUT_DRIFT_CHECK_MAX: PHASE10_RULES.ADMISSIONS_WITHOUT_DRIFT_CHECK_MAX,

  /** IMPORTED from Phase 9 §5.4. A "mixed" generation holding one kind is not mixed. */
  MIN_TORBOX_ENTRIES: PHASE9_RULES.MIN_TORBOX_ENTRIES,
  MIN_ADMITTED_USENET_ENTRIES: PHASE9_RULES.MIN_ADMITTED_USENET_ENTRIES,
} as const);

export type Phase11RuleKey = keyof typeof PHASE11_RULES;

/** The compose port. Cross-checked against every other compose file by `test/projection-phase11.ts`. */
export const PHASE11_GATE_PG_PORT = 5680;

/** The fake range origin's loopback port. Cross-checked the same way, against scripts as well as compose. */
export const PHASE11_FAKE_ORIGIN_PORT = 8300;

/** The three real media servers of P11-R2, and the ids are Phase 7's own so no report can disagree. */
export const PHASE11_SERVER_IDS = PHASE7_SERVER_IDS;

// ---------------------------------------------------------------------------------------------------------
// §5 — the fourteen claims, in two tiers
// ---------------------------------------------------------------------------------------------------------

/**
 * The six predeclared arms of §5.2 and §5.4, in the contract's own order.
 *
 * PREDECLARED IS THE LOAD-BEARING WORD. These are fixed by the document before the gate exists, which is what
 * gives `UNREACHED_ARMS_MAX` a denominator. The gate emits `ARM <id> reached` at the START of each and a
 * verdict at its end, and `phase11UnreachedArms` is the difference.
 */
export const PHASE11_ARM_GATE_IDS = Object.freeze([
  'P11-M1-mixed-generation-assembled',
  'P11-M2-both-halves-readable-through-one-mount',
  'P11-M3-publish-does-not-move-the-other-half',
  'P11-M4-one-source-failing-disturbs-nothing-of-the-other',
  'P11-M5-shipped-verbs-only-and-nothing-implicit',
  'P11-M6-arms-reached-cleanup-and-redaction',
] as const);

/** The four tier-one claims about a SET of runs, which one gate run is not a member of. */
export const PHASE11_SEQUENCE_LEVEL_GATE_IDS = Object.freeze([
  'P11-S1-offline-inventory-both-shells',
  'P11-S2-mixed-gate-three-fresh',
  'P11-S3-provider-free-regression-subset-green',
  'P11-S4-three-consecutive-fresh-sequences',
] as const);

/**
 * The four tier-two claims. NOT RUN, and not runnable by anything in this repository.
 *
 * EVERY ONE OF THEM NEEDS SOMETHING ONLY THE OPERATOR POSSESSES. §9.2 lists the inputs; §4's third refusal
 * forbids a fake run from claiming one; and the absence of these ids from `PHASE11_FAKE_EMITTABLE_GATE_IDS`
 * is that refusal in the one place a gate script is measured against.
 */
export const PHASE11_TIER_TWO_GATE_IDS = Object.freeze([
  'P11-R1-real-mixed-generation-on-the-appliance',
  'P11-R2-three-servers-scan-and-read-both',
  'P11-R3-real-provider-outage-leaves-the-other-half-readable',
  'P11-R4-three-consecutive-fresh-real-sequences',
] as const);

/** Tier one: the instrument. Ten claims, every one provider-free and answerable on one host. */
export const PHASE11_TIER_ONE_GATE_IDS: readonly string[] = Object.freeze([
  ...PHASE11_ARM_GATE_IDS,
  ...PHASE11_SEQUENCE_LEVEL_GATE_IDS,
]);

/** All fourteen, in the document's order. The ids are the contract's numbering, not a re-statement of it. */
export const PHASE11_CLOSURE_GATE_IDS = Object.freeze([
  ...PHASE11_ARM_GATE_IDS,
  ...PHASE11_SEQUENCE_LEVEL_GATE_IDS,
  ...PHASE11_TIER_TWO_GATE_IDS,
] as const);

export type Phase11GateId = (typeof PHASE11_CLOSURE_GATE_IDS)[number];
export type Phase11ArmId = (typeof PHASE11_ARM_GATE_IDS)[number];

export type Phase11Tier = 'one' | 'two';

/** Which tier a claim belongs to. The only place the split is decided, so no report can disagree. */
export function phase11TierOf(gateId: string): Phase11Tier | undefined {
  if ((PHASE11_TIER_TWO_GATE_IDS as readonly string[]).includes(gateId)) return 'two';
  if (PHASE11_TIER_ONE_GATE_IDS.includes(gateId)) return 'one';
  return undefined;
}

/**
 * WHAT A FAKE-MODE GATE RUN MAY EMIT: the six arms, and nothing else.
 *
 * THIS IS THE MOST IMPORTANT LIST IN THE FILE. The four sequence-level ids are absent because a claim about a
 * SET of runs is not answerable by one member of it — Phase 10's `PHASE10_SEQUENCE_LEVEL_GATE_IDS` makes the
 * same refusal for the same reason. The four tier-two ids are absent because §4's third refusal says a fake
 * run may not record one in any form, and a list is the only place that refusal can be checked against the
 * script that actually runs.
 */
export const PHASE11_FAKE_EMITTABLE_GATE_IDS: readonly string[] = Object.freeze([...PHASE11_ARM_GATE_IDS]);

export const PHASE11_GATE_TITLES: Readonly<Record<Phase11GateId, string>> = Object.freeze({
  'P11-M1-mixed-generation-assembled':
    'one published generation holds a provider-backed entry and a worker-produced local entry',
  'P11-M2-both-halves-readable-through-one-mount':
    'each half is readable through the one mount for what it is, and neither is served by the other\'s path',
  'P11-M3-publish-does-not-move-the-other-half':
    'publishing a generation that adds one half leaves the other half identical in every recorded field',
  'P11-M4-one-source-failing-disturbs-nothing-of-the-other':
    'a failure injected into one source disturbs zero recorded fields of the other, which stays readable',
  'P11-M5-shipped-verbs-only-and-nothing-implicit':
    'the mixed sequence needs no hand-run command and no intervention, and nothing publishes implicitly',
  'P11-M6-arms-reached-cleanup-and-redaction':
    'every declared arm was reached, cleanup left nothing, and no evidence carries an identity',
  'P11-S1-offline-inventory-both-shells':
    'the full offline inventory passes with every Phase 11 suite in it, from Git Bash and from PowerShell',
  'P11-S2-mixed-gate-three-fresh':
    'three consecutive fresh mixed-gate runs on the real host, exit 0, zero skips',
  'P11-S3-provider-free-regression-subset-green':
    'the provider-free regression subset is green from one frozen candidate',
  'P11-S4-three-consecutive-fresh-sequences':
    'the complete tier-one sequence passes three consecutive fresh times',
  'P11-R1-real-mixed-generation-on-the-appliance':
    'a real provider object and a real admitted Usenet file sit in one published generation',
  'P11-R2-three-servers-scan-and-read-both':
    'Plex, Jellyfin and Emby each scan and read both entries through their pre-attached binds',
  'P11-R3-real-provider-outage-leaves-the-other-half-readable':
    'a real provider outage leaves the other half readable and the mounted namespace stable',
  'P11-R4-three-consecutive-fresh-real-sequences':
    'the complete mixed-product sequence passes three consecutive fresh times',
});

/**
 * Which gate ids carry a measured number, and which threshold each is measured against.
 *
 * A gate id that returns `undefined` here is a PASS/FAIL claim with nothing to measure, and supplying a
 * measurement for one is a run that has invented a budget. §5.3's last paragraph, as a function.
 *
 * EXACTLY TWO OF THE SIX ARMS CARRY A NUMBER, and they are the two the contract names: P11-M4's cross-source
 * disturbance and P11-M6's unreached-arm count. The other four are pass/fail because there is nothing about
 * them a number would say that the verdict does not.
 */
export function phase11BudgetKeyFor(gateId: string): Phase11RuleKey | undefined {
  switch (gateId) {
    case 'P11-M4-one-source-failing-disturbs-nothing-of-the-other':
      return 'CROSS_SOURCE_FIELDS_DISTURBED_MAX';
    case 'P11-M6-arms-reached-cleanup-and-redaction':
      return 'UNREACHED_ARMS_MAX';
    case 'P11-S2-mixed-gate-three-fresh':
    case 'P11-S4-three-consecutive-fresh-sequences':
    case 'P11-R4-three-consecutive-fresh-real-sequences':
      return 'CONSECUTIVE_FRESH_RUNS';
    default:
      return undefined;
  }
}

/** The one threshold that is a FLOOR. Every other one is a ceiling of zero. */
const FLOOR_KEYS: readonly Phase11RuleKey[] = Object.freeze([
  'CONSECUTIVE_FRESH_RUNS',
  'MIN_TORBOX_ENTRIES',
  'MIN_ADMITTED_USENET_ENTRIES',
]);

// ---------------------------------------------------------------------------------------------------------
// P11-M6's measurement — reached is not passed
// ---------------------------------------------------------------------------------------------------------

/**
 * The arms this gate DECLARED and did not REACH.
 *
 * WHY THIS IS A FUNCTION AND NOT A CONSTANT, AND IT IS THE LESSON OF PHASE 10's OWN INDEPENDENT AUDIT. That
 * audit's seventh defect was a rehearsal that set `HAND_RUN=0` and then asserted it was zero: no line in the
 * file could move the variable, so the budget was measured by nothing and adding a hand-run command would
 * have left the claim passing while reporting the same 0.
 *
 * So the gate writes an `ARM <id> reached` marker at the START of each arm, the reached set is READ BACK out
 * of the run, and the difference against this module's predeclared list is the measurement. An arm a
 * conditional jumped over leaves no marker and the number moves.
 *
 * REACHED IS NOT PASSED. An arm that ran and failed is evidence and appears here as reached; the failure is
 * carried by its own verdict. The absence of evidence is what this counts.
 */
export function phase11UnreachedArms(reached: readonly string[]): readonly string[] {
  const seen = new Set(reached);
  return PHASE11_ARM_GATE_IDS.filter((id) => !seen.has(id));
}

/**
 * Every arm marker a run reported that this contract does not declare.
 *
 * THE OTHER DIRECTION, AND IT MATTERS AS MUCH. A run that invented a seventh arm would raise its own
 * denominator and could report "every arm reached" while never having run one of the six. §5.4: the arms are
 * predeclared, and a gate that chose its own at run time is a gate whose green run is about the arms it felt
 * like running.
 */
export function phase11UndeclaredArms(reached: readonly string[]): readonly string[] {
  return [...new Set(reached)].filter((id) => !(PHASE11_ARM_GATE_IDS as readonly string[]).includes(id));
}

/**
 * WHAT "EVERY RECORDED FIELD" MEANS, so P11-M3 and P11-M4 are not measured against a subset a gate chose.
 *
 * These are the six the shipped `status --json` surface carries per entry. A gate that picked its own subset
 * would be a gate whose zero is about the fields it felt like comparing, and the comparison is therefore over
 * the WHOLE record — a field present in one capture and absent from the other counts as moved.
 *
 * THE LOCATOR IS DELIBERATELY ABSENT AND THAT IS A REFUSAL RATHER THAN A GAP. §4's ninth refusal keeps a
 * provider object reference out of every emitted document, so the shipped surface does not carry one; a gate
 * that diffed a locator would first have to put that reference into its own evidence, which is the exact
 * thing P11-M6 asserts no preserved file does. The two claims cannot both be satisfied, and this contract
 * chooses the refusal — covering what a moved locator would actually break by re-reading the other half
 * THROUGH THE MOUNT and comparing its bytes.
 */
export const PHASE11_RECORDED_ENTRY_FIELDS: readonly string[] = Object.freeze([
  'path',
  'kinds',
  'sizeBytes',
  'visibility',
  'degradedReason',
  'publication',
]);

/**
 * Whether a generation is MIXED, as sentences. Empty means it is.
 *
 * §5.1's P11-M1, and both minimums are Phase 9's own read from Phase 9's module. A generation holding two
 * entries of one kind is not a mixed generation, and calling it one is the only way this tranche could
 * report a pass having composed nothing.
 */
export function phase11MixedGenerationProblems(counts: {
  readonly httpRange: number;
  readonly local: number;
}): readonly string[] {
  const problems: string[] = [];
  if (counts.httpRange < PHASE11_RULES.MIN_TORBOX_ENTRIES) {
    problems.push(`the generation holds ${counts.httpRange} provider-backed entries and §5.1 requires at least `
      + `${PHASE11_RULES.MIN_TORBOX_ENTRIES}, so it is not a mixed generation`);
  }
  if (counts.local < PHASE11_RULES.MIN_ADMITTED_USENET_ENTRIES) {
    problems.push(`the generation holds ${counts.local} worker-produced local entries and §5.1 requires at `
      + `least ${PHASE11_RULES.MIN_ADMITTED_USENET_ENTRIES}, so it is not a mixed generation`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// Closure
// ---------------------------------------------------------------------------------------------------------

export interface Phase11GateResult {
  readonly gate: string;
  readonly verdict: 'pass' | 'fail' | 'skip';
  readonly measured?: number;
  readonly budget?: number;
  /** True when this verdict came from the fake-mode gate rather than from a run against real inputs. */
  readonly fake?: boolean;
}

export interface Phase11Results {
  /** One entry per fresh sequence, numbered from one. */
  readonly sequences: readonly { readonly index: number }[];
  readonly results: readonly Phase11GateResult[];
  /**
   * Which tier this evidence is offered as closing. A run must SAY, because the same six arms appear in both
   * and the difference is entirely in what else is present.
   */
  readonly tier: Phase11Tier;
}

/**
 * Everything wrong with a run's evidence, as sentences.
 *
 * A LIST RATHER THAN A BOOLEAN, for the reason `phase10ClosureProblems` gives: somebody assembling a run
 * should learn everything that is missing in one pass rather than one thing per attempt.
 *
 * IT IS TIER-AWARE, AND THAT IS THE WHOLE OF PHASE 10 §8.1. A tier-one closure asks for the ten tier-one
 * claims and REFUSES to look at a tier-two verdict at all; a tier-two closure asks for all fourteen and
 * refuses any verdict on a tier-two claim that carries `fake: true`.
 */
export function phase11ClosureProblems(results: Phase11Results): readonly string[] {
  const problems: string[] = [];

  const required = results.tier === 'one' ? PHASE11_TIER_ONE_GATE_IDS : PHASE11_CLOSURE_GATE_IDS;

  const sequences = results.sequences.length;
  if (sequences !== PHASE11_RULES.CONSECUTIVE_FRESH_RUNS) {
    problems.push(`the run reports ${sequences} fresh sequences; §5 requires `
      + `${PHASE11_RULES.CONSECUTIVE_FRESH_RUNS}, and a shorter run closes nothing`);
  }
  for (let index = 0; index < results.sequences.length; index += 1) {
    if (results.sequences[index]?.index !== index + 1) {
      problems.push('the fresh sequences are not numbered from one without a gap, so at least one is missing '
        + 'or has been reported twice');
      break;
    }
  }

  const seen = new Map<string, Phase11GateResult>();
  for (const result of results.results) {
    if (!(PHASE11_CLOSURE_GATE_IDS as readonly string[]).includes(result.gate)) {
      problems.push(`the run reports a verdict for ${result.gate}, which §5 does not name`);
      continue;
    }
    // A TIER-ONE CLOSURE MAY NOT CARRY A TIER-TWO VERDICT AT ALL. Phase 10 §8.1: a tier-one GO closes nothing
    // about the mixed product, and evidence that mixes the two is evidence a reader will average.
    if (results.tier === 'one' && phase11TierOf(result.gate) === 'two') {
      problems.push(`${result.gate} is a tier-two claim and this run is offered as closing tier one, which `
        + 'Phase 10 §8.1 says closes nothing about the mixed product');
      continue;
    }
    if (seen.has(result.gate)) {
      // A DUPLICATE VERDICT IS NOT A CONFIRMATION. Two verdicts for one claim means either the run happened
      // twice and only one of them is being read, or two different things answer to one id.
      problems.push(`${result.gate} carries more than one verdict, so it is not clear which one is the run's`);
      continue;
    }
    seen.set(result.gate, result);
  }

  for (const gateId of required) {
    const result = seen.get(gateId);
    if (result === undefined) {
      problems.push(`§5 claim ${gateId} has no verdict, and an absent verdict is not a pass`);
      continue;
    }
    if (result.verdict === 'skip') {
      problems.push(`${gateId} was skipped or is NOT RUN; a skip proves nothing and is never folded into a pass`
        + (phase11TierOf(gateId) === 'two'
          ? ' — this claim needs operator TorBox credentials, an operator SABnzbd with a real NNTP provider '
            + 'behind it, an entitled NZB, and three real pre-attached media servers' : ''));
      continue;
    }
    if (result.verdict !== 'pass') {
      problems.push(`${gateId} did not pass`);
      continue;
    }
    // THE REFUSAL PHASE 10 §8.1 AUTHORISED THIS TRANCHE ON. A fake range origin and a fake worker say nothing
    // about a real provider's timing, a real article's arrival, or what three real media servers do when they
    // scan a directory holding both kinds.
    if (result.fake === true && phase11TierOf(gateId) === 'two') {
      problems.push(`${gateId} passed only in fake mode, and §5.2 asks it of real operator inputs and three `
        + 'real pre-attached media servers');
    }
    // A CLAIM ABOUT A SET OF RUNS IS NOT ANSWERABLE BY ONE MEMBER OF IT. The same refusal Phase 10 makes, and
    // the reason the gate's own emittable set is the six arms alone.
    if (result.fake === true && (PHASE11_SEQUENCE_LEVEL_GATE_IDS as readonly string[]).includes(gateId)) {
      problems.push(`${gateId} passed only in one gate run, and §5 asks it of a set of runs this one is not a `
        + 'member of');
    }
    const key = phase11BudgetKeyFor(gateId);
    if (key === undefined) {
      if (result.measured !== undefined || result.budget !== undefined) {
        problems.push(`${gateId} reports a measurement against a budget §5.3 does not give it`);
      }
      continue;
    }
    const budget = PHASE11_RULES[key];
    if (result.budget !== budget) {
      problems.push(`${gateId} was measured against ${String(result.budget)} rather than against the `
        + `contract's ${String(budget)}, so the verdict is against a budget this phase did not set`);
      continue;
    }
    if (typeof result.measured !== 'number') {
      problems.push(`${gateId} passed without recording what it measured`);
      continue;
    }
    const isFloor = FLOOR_KEYS.includes(key);
    if (isFloor ? result.measured < budget : result.measured > budget) {
      problems.push(`${gateId} passed while reporting ${result.measured} against a budget of ${budget}`);
    }
  }

  return problems;
}

/** True only when nothing is wrong. The only place a boolean is derived from the list. */
export function phase11Closed(results: Phase11Results): boolean {
  return phase11ClosureProblems(results).length === 0;
}

/**
 * The sentence a tier-one GO may write, and the one it may not exceed.
 *
 * PHASE 10 §8.1 WROTE IT, NOT THIS TRANCHE. It is held here as a constant so that a summary which grew past
 * it has to edit a module, and `test/projection-phase11.ts` asserts both documents still contain it.
 */
export const PHASE11_TIER_ONE_CEILING_SENTENCE = 'what is missing is a run rather than a gate';

/**
 * What a tier-one GO says, in the words Phase 10 §8.1 authorised and no more.
 */
export const PHASE11_TIER_ONE_MEANING =
  'a tier-one GO is a GO on the instrument: it says the gate exists, can fail, and reached every arm in fake '
  + 'mode. It closes nothing about the mixed product.';

/**
 * The claims this tranche does NOT make, restated from §8 so a report cannot quietly imply one.
 *
 * `test/projection-phase11.ts` asserts that the phase document still says each of these, which is what stops
 * a summary from growing a claim the contract never authorised.
 */
export const PHASE11_NONCLAIMS = Object.freeze([
  'a soak',
  'a load test',
  'an uptime claim',
  'a second host',
  'high availability',
  'a production release',
  'Real-Debrid',
  'instant Usenet streaming',
  'automatic source failover',
  'indexer search',
] as const);

/**
 * The four Phase 9 claims Phase 11 may not close, re-label, re-word or partially satisfy, and the four Phase
 * 10 claims it does not answer either.
 *
 * §4's second refusal and §8. Phase 10 §8's prerequisite — that Phase 9's open claims be run from a Phase
 * 10-or-later candidate — is INHERITED by this tranche and discharged by none of it.
 */
export const PHASE11_UNTOUCHABLE_PHASE9_CLAIMS: readonly string[] = Object.freeze([
  'P9-2-real-job-admitted-once',
  'P9-3-failed-job-refused-and-absent',
  'P9-5-three-servers-scan-and-read-both',
  'P9-11-three-consecutive-fresh-sequences',
]);

/**
 * What an operator must supply before tier two can run at all.
 *
 * IT IS A LIST OF INPUTS, NOT A LIST OF TASKS — Phase 9 `PHASE9_OPERATOR_INPUTS`' own distinction. Everything
 * on it is something only the operator possesses, and nothing on it is something this project could build,
 * fake or infer. That is what makes "provider-free ready" an honest stopping point rather than an excuse.
 */
export const PHASE11_TIER_TWO_OPERATOR_INPUTS = Object.freeze([
  'TorBox credentials and at least one object the operator is entitled to',
  'a running SABnzbd the operator controls, with an NNTP provider already configured IN THE WORKER',
  'at least one NZB or indexer URL for content the operator is legally entitled to download',
  'one NZB the operator expects to FAIL or arrive incomplete',
  'the worker\'s complete directory placed under the media root the appliance already serves',
  'three real, already-attached media servers: Plex, Jellyfin and Emby',
] as const);

/**
 * The paths this tranche is forbidden to modify, so §4's fourth, fifth and eighth refusals are checkable
 * rather than promised.
 */
export const PHASE11_FORBIDDEN_SOURCE: readonly string[] = Object.freeze([
  'deploy/projection-alpha.sh',
  'deploy/projection-content.sh',
  'deploy/projectiond-alpha.env.example',
  'docker-compose.projection-alpha.yml',
  'docs/PROJECTION_PHASE_9_TORBOX_USENET.md',
  'docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md',
  'src/ops/projection-content.ts',
  'src/ops/projection-content-cli.ts',
  'src/core/projection/phase7.ts',
  'src/core/projection/phase8.ts',
  'src/core/projection/phase9.ts',
  'src/core/projection/phase10.ts',
]);

/**
 * EVERY PATH THIS TRANCHE CREATES OR MODIFIES.
 *
 * WHAT IT IS FOR: `test/projection-phase11.ts` runs `phase9RequiresSoakRerun` over this list and asserts the
 * answer is FALSE. §3.1's first consequence — this tranche ships NO PRODUCT SOURCE — makes that easy, and the
 * list is what turns "easy" into "checked". A suite that re-implemented the rule would be a suite that could
 * disagree with the product about whether a six-hour soak has to be re-run.
 *
 * WHAT IT IS NOT: a substitute for the OPERATOR SOURCE DIGEST, which `test/projection-bounded-recovery.ts`
 * recomputes on every run. This list is maintained by the people editing it, so on its own it could be wrong
 * in exactly the way that matters.
 */
export const PHASE11_TRANCHE_PATHS: readonly string[] = Object.freeze([
  'docs/PROJECTION_PHASE_11_MIXED_SOURCE_ACCEPTANCE.md',
  'src/core/projection/phase11.ts',
  'deploy/projection-phase11-mixed-gate.sh',
  'deploy/projection-phase11-mixed-gate-three.sh',
  'deploy/projection-phase11-mixed-gate-optional.sh',
  'docker-compose.projection-phase11.yml',
  'test/projection-phase11.ts',
  'test/projection-phase11-gate-audit.ts',
  'test/suite-inventory.json',
  'package.json',
]);
