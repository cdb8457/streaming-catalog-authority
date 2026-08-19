import { PHASE12_RULES } from './phase12.js';
import {
  ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES,
  ORIGIN_RECORD_MAX_AGE_MINUTES,
  originRotationDisposition,
  originStabilityRefusals,
  type OriginStabilityPlan,
} from './phase13-preentry.js';

// Projection Phase 13 — the real provider acceptance contract, as code rather than as prose.
//
// WHAT THIS IS, AND WHAT IT IS NOT. It is NOT a run and it does not enter Phase 13. It is the contract a
// later, separately authorised run is measured against: eleven claims, sixteen thresholds, nine entry
// criteria and six exit criteria, written before anything is run so that the run cannot choose them. The
// document is `docs/PROJECTION_PHASE_13_REAL_PROVIDER_ACCEPTANCE.md` and it was committed BEFORE this file.
//
// IT NAMES NO PROVIDER, imports no gate, touches no filesystem and contacts nothing — so, like `phase12.ts`
// and `phase13-preentry.ts` before it, no source allowlist has to be widened for it. The provider is named in
// the phase document and in the suites, which is where a filename that names one already belongs.
//
// WHAT IT DOES NOT MOVE, AND THIS IS THE FIRST LINE OF ITS RECORD. Phase 10, Phase 11 tier one and Phase 12
// are GO and stay exactly as they are; Phase 9's open claims and Phase 11 TIER TWO stay exactly as OPEN as
// they were. In particular `P11-R1` is NOT RUN and has no provider half to close — it is a conjunction about
// two kinds of entry sharing ONE published generation, and Phase 13 supplies one conjunct. Nothing in this
// module can express a half, which is the point.
//
// THE ORIGIN POLICY IS IMPORTED RATHER THAN RESTATED. `phase13-preentry.ts` carries `originStabilityRefusals`
// and `originRotationDisposition` and their two constants; a module carrying its own copy of a threshold is a
// module whose threshold can drift from the document's, silently, in the direction that lets a run start.

/**
 * The thresholds.
 *
 * TEN ARE NEW AND SIX ARE IMPORTED. Every imported one is read from the module of the tranche it came from,
 * so it cannot drift here in the passing direction; every new one is a number no earlier tranche could have
 * measured, because no earlier tranche has contacted a provider.
 */
export const PHASE13_RULES = Object.freeze({
  /** An input check that contacted something spent a resolution to discover a typo. */
  PREFLIGHT_CONTACTS_MAX: 0,
  /** A byte that came back wrong is the whole product failing, and there is no interesting fraction of it. */
  READ_MISMATCHES_MAX: 0,
  /**
   * THE ONLY FLOOR IN THIS CONTRACT, and the reason it exists is worth reading twice.
   *
   * Every ceiling in this table is satisfied by a run that contacted nothing at all: zero mismatches, zero
   * secret traces, zero admitted writes, zero host losses. A provider-facing gate whose every assertion is
   * satisfied by silence is a gate that can report a pass for a run that never dialled anything. This is the
   * number that makes "the provider was actually contacted" an assertion rather than an assumption.
   */
  RESOLUTIONS_PER_OBJECT_MIN: 1,
  /**
   * Access material is valid for hours and the run is seconds long, so a second resolution for the same
   * object is a resolution storm against a metered account rather than a data plane doing its job.
   */
  RESOLUTIONS_PER_OBJECT_MAX: 1,
  /**
   * The provider authenticates with a QUERY PARAMETER, so a request URL is itself a bearer credential.
   * Anything that logs one publishes the key, which is why the scan is byte-exact and the budget is zero.
   */
  SECRET_TRACES_MAX: 0,
  /** Measured as BOTH uids: a refusal that only holds for an unprivileged uid is not the daemon's refusal. */
  WRITE_PATHS_ADMITTED_MAX: 0,
  /** "Left as found" is about a SET. A count is satisfied by a removal and a creation. */
  HOST_SET_LOSSES_MAX: 0,
  /**
   * The allowlist is perishable and the pool rotates faster than a sequence takes. A movement is escalated
   * as a count and a digest, and is never edited to make a run go green.
   */
  ALLOWLIST_MEMBERS_MOVED_MAX: 0,
  /** 77 is a skip. "Two of three passed" is not what three consecutive fresh runs means. */
  SKIPPED_RUNS_MAX: 0,
  /** The offline inventory's own counter, which is the number a run stopped part-way moves. */
  REQUIRED_BUT_SKIPPED_MAX: 0,

  CONSECUTIVE_FRESH_RUNS: PHASE12_RULES.CONSECUTIVE_FRESH_RUNS,
  SKIPPED_CLAIMS_MAX: PHASE12_RULES.SKIPPED_CLAIMS_MAX,
  RESIDUE_MAX: PHASE12_RULES.RESIDUE_MAX,
  REPAIRS_WITHOUT_A_CONTROL_MAX: PHASE12_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX,
  ORIGIN_RECORD_MAX_AGE_MINUTES,
  ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES,
});

export type Phase13RuleKey = keyof typeof PHASE13_RULES;

/**
 * TIER A — the provider-facing arms. NOT ANSWERABLE WITHOUT A REAL ACCOUNT.
 *
 * Every one is a statement about a run against the operator's own account, and `phase13ClosureProblems`
 * refuses a result set whose mode is anything but `real`. A fake run may not record one of these, which is
 * the rule Phase 11 §4's third refusal established and this tranche inherits.
 */
export const PHASE13_ACCEPTANCE_GATE_IDS = Object.freeze([
  'P13-A1-operator-inputs-preflight-before-any-contact',
  'P13-A2-a-generation-of-the-operators-references-is-published-and-mounted',
  'P13-A3-the-operators-objects-read-back-byte-correct',
  'P13-A4-exactly-one-resolution-per-object',
  'P13-A5-the-api-key-never-enters-the-daemon-and-nothing-written-carries-a-secret',
  'P13-A6-the-mount-refuses-writes-as-an-unprivileged-uid-and-as-uid-0',
  'P13-A7-the-host-is-left-as-it-was-found',
  'P13-A8-the-origin-allowlist-is-unmoved-before-and-after',
] as const);

/** TIER S — the sequence, and the candidate it ran from. */
export const PHASE13_SEQUENCE_GATE_IDS = Object.freeze([
  'P13-S1-three-consecutive-fresh-real-runs-zero-skips',
  'P13-S2-the-candidate-carries-a-phase-12-go-of-its-own',
  'P13-S3-typecheck-and-full-offline-inventory-both-shells',
] as const);

/** The eleven, in the order §5 states them. */
export const PHASE13_CLOSURE_GATE_IDS = Object.freeze([
  ...PHASE13_ACCEPTANCE_GATE_IDS, ...PHASE13_SEQUENCE_GATE_IDS,
] as const);

export type Phase13GateId = (typeof PHASE13_CLOSURE_GATE_IDS)[number];

/** One line per claim, so a reader of a result set does not have to hold the document open beside it. */
export const PHASE13_GATE_TITLES: Readonly<Record<Phase13GateId, string>> = Object.freeze({
  'P13-A1-operator-inputs-preflight-before-any-contact':
    'all four operator inputs are usable, both secrets are 0600 and differ, and every input check passes '
    + 'with nothing built, started or contacted',
  'P13-A2-a-generation-of-the-operators-references-is-published-and-mounted':
    'a generation whose sources are the operator\'s stable references is published, and the daemon serves '
    + 'it as ordinary read-only files through a FUSE mount',
  'P13-A3-the-operators-objects-read-back-byte-correct':
    'every declared probe window of every object reads back matching the digest authority the corpus '
    + 'declares, through the mount',
  'P13-A4-exactly-one-resolution-per-object':
    'the resolver resolved at least once per object, so the provider was genuinely contacted, and at most '
    + 'once per object, so no read after the first minted fresh access material against a metered account',
  'P13-A5-the-api-key-never-enters-the-daemon-and-nothing-written-carries-a-secret':
    'the provider credential is absent from the daemon container\'s filesystem, and a byte-exact scan of '
    + 'everything this run wrote and both containers\' logs finds neither secret and no object reference',
  'P13-A6-the-mount-refuses-writes-as-an-unprivileged-uid-and-as-uid-0':
    'write, create, unlink and chmod are refused through the mount both as the uid a media server runs as '
    + 'and as uid 0, which permissions cannot refuse',
  'P13-A7-the-host-is-left-as-it-was-found':
    'the container, network and volume sets are preserved as membership rather than as counts; no '
    + 'mountpoint and no run directory survives; the appliance is untouched',
  'P13-A8-the-origin-allowlist-is-unmoved-before-and-after':
    'a no-contact readiness record taken immediately before the sequence and immediately after carries the '
    + 'same whole-file digest, the same member count and the same member digests',
  'P13-S1-three-consecutive-fresh-real-runs-zero-skips':
    'the three-run wrapper completes three consecutive fresh runs, none skipped and none failed, each from '
    + 'a fresh database, manifest directory, resolver, mount and probe cache, from one frozen candidate',
  'P13-S2-the-candidate-carries-a-phase-12-go-of-its-own':
    'the complete Phase 12 provider-free sequence has been run from THIS candidate, three consecutive fresh '
    + 'times, with zero skips',
  'P13-S3-typecheck-and-full-offline-inventory-both-shells':
    'typecheck clean, and the full offline inventory green from Git Bash and from an ordinary PowerShell, '
    + 'from that same candidate',
});

/**
 * EVERY budget §5's Budget column gives a claim, in the document's own order.
 *
 * WHY THE MAPPING IS A LIST, AND IT WAS FOUND BY RUNNING BOTH SIDES RATHER THAN BY READING EITHER. §5's
 * Budget column names TWO thresholds for four of the eleven claims, and the first version of this module
 * returned one key per claim. A single-key answer cannot say "and also", so `RESIDUE_MAX` — the budget §5.1
 * gives `P13-A7`'s residue half — was read by nothing, `CONSECUTIVE_FRESH_RUNS` was read by nothing at
 * closure, and `P13-S2` was given no budget at all and therefore ACTIVELY REFUSED a result set that recorded
 * itself the way §5.2 documents it. That is Phase 12 §11.4's defect — the shipped function disagreeing with
 * the prose it was written from — recurring in the one part of §5 the suite never compared.
 *
 * A CLAIM WITH NO BUDGET HAS NOTHING TO MEASURE, and a run that supplies a measurement for one has invented
 * a budget. `phase13ClosureProblems` refuses both directions, which is Phase 11's rule and Phase 12's.
 */
export function phase13BudgetKeysFor(gate: string): readonly Phase13RuleKey[] {
  if (gate.startsWith('P13-A1-')) return ['PREFLIGHT_CONTACTS_MAX'];
  if (gate.startsWith('P13-A3-')) return ['READ_MISMATCHES_MAX'];
  if (gate.startsWith('P13-A4-')) return ['RESOLUTIONS_PER_OBJECT_MIN', 'RESOLUTIONS_PER_OBJECT_MAX'];
  if (gate.startsWith('P13-A5-')) return ['SECRET_TRACES_MAX'];
  if (gate.startsWith('P13-A6-')) return ['WRITE_PATHS_ADMITTED_MAX'];
  if (gate.startsWith('P13-A7-')) return ['HOST_SET_LOSSES_MAX', 'RESIDUE_MAX'];
  if (gate.startsWith('P13-A8-')) return ['ALLOWLIST_MEMBERS_MOVED_MAX'];
  if (gate.startsWith('P13-S1-')) return ['CONSECUTIVE_FRESH_RUNS', 'SKIPPED_RUNS_MAX'];
  if (gate.startsWith('P13-S2-')) return ['CONSECUTIVE_FRESH_RUNS', 'SKIPPED_CLAIMS_MAX'];
  if (gate.startsWith('P13-S3-')) return ['REQUIRED_BUT_SKIPPED_MAX'];
  // `P13-A2` is the one claim §5 gives no budget: a generation is published and mounted or it is not, and
  // there is no number of it.
  return [];
}

/**
 * The ONE ceiling a claim's own `measured`/`budget` pair is compared against, or `undefined`.
 *
 * IT IS DERIVED FROM `phase13BudgetKeysFor` RATHER THAN RESTATED, so the two cannot drift. Where §5 names a
 * second threshold it is measured by its own named field on the result — a set loss and a survivor are
 * different events, and a floor on runs is the half a single-ceiling shape drops.
 */
export function phase13BudgetKeyFor(gate: string): Phase13RuleKey | undefined {
  const keys = phase13BudgetKeysFor(gate);
  if (keys.length === 1) return keys[0];
  // `P13-A4` is the one claim measured against a RANGE, and it is handled on its own below rather than
  // squeezed into a single-ceiling shape that would drop its floor.
  if (gate.startsWith('P13-A4-')) return undefined;
  if (gate.startsWith('P13-A7-')) return 'HOST_SET_LOSSES_MAX';
  if (gate.startsWith('P13-S1-')) return 'SKIPPED_RUNS_MAX';
  if (gate.startsWith('P13-S2-')) return 'SKIPPED_CLAIMS_MAX';
  return undefined;
}

export interface Phase13GateResult {
  readonly gate: string;
  readonly verdict: 'pass' | 'fail' | 'skip';
  readonly measured?: number;
  readonly budget?: number;
  /** `P13-A4` only: how many objects the measurement is per. A ratio with no denominator is a number. */
  readonly perObjectDenominator?: number;
  /**
   * `P13-A7` only: how many artefacts of this run SURVIVED on the host, against `RESIDUE_MAX`.
   *
   * IT IS NOT THE SAME NUMBER AS `measured`. `HOST_SET_LOSSES_MAX` counts names that were present before and
   * are absent after — things the run DESTROYED. A mountpoint, a run directory or a container the run
   * CREATED and left behind is a loss of nothing and a residue of one, and §5.1 gives the claim both budgets
   * because "left as it was found" is broken in both directions.
   */
  readonly residueSurviving?: number;
  /**
   * `P13-S1` and `P13-S2` only: how many consecutive fresh runs the claim actually counted, against
   * `CONSECUTIVE_FRESH_RUNS`, which is a FLOOR.
   *
   * WHY IT IS A SEPARATE FIELD. Every other number in this contract is a ceiling, and one run with zero
   * skips satisfies every ceiling these two claims carry. "Two of three passed" is not what three
   * consecutive fresh runs means, and without this the sentence is a title rather than a measurement.
   */
  readonly consecutiveFreshRuns?: number;
}

export interface Phase13Results {
  /**
   * WHETHER THE RUN CONTACTED THE PROVIDER AT ALL.
   *
   * IT IS REQUIRED AND IT IS NOT A BOOLEAN. A boolean defaults, and a field that defaults to the permissive
   * value is a field a run can leave out. `fake` is what every provider-free rehearsal is; `real` is the
   * only mode a Tier A verdict may be recorded from.
   */
  readonly mode: 'real' | 'fake';
  readonly results: readonly Phase13GateResult[];
}

export function phase13SkippedClaims(results: Phase13Results): readonly string[] {
  return results.results.filter((one) => one.verdict === 'skip').map((one) => one.gate);
}

/**
 * The ids Phase 13 may NEVER emit a verdict for, in any direction.
 *
 * WHY IT IS A LIST AS WELL AS A PREFIX RULE. Phase 12 §12.1 said Phase 13 may close "the provider half only
 * of `P11-R1`", and Phase 12 §13.1 supersedes that: the claim is a conjunction about co-residency and a
 * conjunction has no half. This list makes the supersession structural — the id cannot appear in a result
 * set this module will accept, so no amount of green can put a verdict beside it.
 */
export const PHASE13_FORBIDDEN_EMITTABLE_IDS: readonly string[] = Object.freeze([
  'P9-2-real-job-admitted-once',
  'P9-3-failed-job-refused-and-absent',
  'P9-5-three-servers-scan-and-read-both',
  'P9-11-three-consecutive-fresh-sequences',
  'P11-R1-real-mixed-generation-on-the-appliance',
  'P11-R2-three-servers-scan-and-read-both',
  'P11-R3-real-provider-outage-leaves-the-other-half-readable',
  'P11-R4-three-consecutive-fresh-real-sequences',
]);

/**
 * Any id belonging to a tranche whose verdicts this one may not write, by prefix.
 *
 * `P13PRE-` IS ON IT ON PURPOSE. That tranche's record is closed, and a Phase 13 run that could write into
 * it would be a Phase 13 run that could re-decide the instrument it is being measured through.
 */
const FOREIGN_ID_PREFIXES: readonly string[] = Object.freeze([
  'P9-', 'P10-', 'P11-', 'P12-', 'P13PRE-',
]);

/**
 * Everything wrong with a Phase 13 run's evidence, as sentences.
 *
 * A LIST RATHER THAN A BOOLEAN: somebody assembling a record should learn everything that is missing in one
 * pass rather than one thing per attempt.
 */
export function phase13ClosureProblems(results: Phase13Results): readonly string[] {
  const problems: string[] = [];

  // THE MODE IS CHECKED FIRST, because every Tier A verdict below is a statement about a real account and a
  // fake run recording one is the single failure this contract exists to prevent.
  if (results.mode !== 'real') {
    problems.push('the run reports mode ' + String(results.mode) + '; every Tier A claim is a statement '
      + 'about the operator\'s own account, and a provider-free rehearsal may not record one');
  }

  const seen = new Map<string, Phase13GateResult>();
  for (const result of results.results) {
    if (PHASE13_FORBIDDEN_EMITTABLE_IDS.includes(result.gate)
      || FOREIGN_ID_PREFIXES.some((prefix) => result.gate.startsWith(prefix))) {
      problems.push(`the run reports a verdict for ${result.gate}, which belongs to another tranche; this `
        + 'one closes nothing of theirs, and in particular there is no provider half of P11-R1 to close');
      continue;
    }
    if (!(PHASE13_CLOSURE_GATE_IDS as readonly string[]).includes(result.gate)) {
      problems.push(`the run reports a verdict for ${result.gate}, which §5 does not name`);
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

  const skipped = phase13SkippedClaims(results);
  if (skipped.length > PHASE13_RULES.SKIPPED_CLAIMS_MAX) {
    problems.push(`${skipped.length} claim(s) were SKIPPED and §5.3 allows `
      + `${PHASE13_RULES.SKIPPED_CLAIMS_MAX}; exit 77 is a skip, a skip is not a pass, and folding one is a `
      + 'decision that belongs in the command somebody typed rather than in a verdict');
  }

  for (const gateId of PHASE13_CLOSURE_GATE_IDS) {
    const result = seen.get(gateId);
    if (result === undefined) {
      problems.push(`§5 claim ${gateId} has no verdict, and an absent verdict is not a pass`);
      continue;
    }
    if (result.verdict === 'skip') {
      problems.push(`${gateId} was skipped; a skip proves nothing and is never folded into a pass`);
      continue;
    }
    if (result.verdict !== 'pass') {
      problems.push(`${gateId} did not pass`);
      continue;
    }

    // `P13-A4` IS THE ONE CLAIM WITH A FLOOR AS WELL AS A CEILING, and it is checked on its own rather than
    // through the single-budget path, which has nowhere to put a minimum. A run that resolved nothing
    // satisfies every other number in this contract.
    if (gateId.startsWith('P13-A4-')) {
      const objects = result.perObjectDenominator;
      if (typeof objects !== 'number' || objects < 1) {
        problems.push(`${gateId} reports no object count, so its per-object ratio has no denominator and `
          + 'the number it carries is not a rate at all');
        continue;
      }
      if (typeof result.measured !== 'number') {
        problems.push(`${gateId} passed without recording how many resolutions it observed`);
        continue;
      }
      const floor = PHASE13_RULES.RESOLUTIONS_PER_OBJECT_MIN * objects;
      const ceiling = PHASE13_RULES.RESOLUTIONS_PER_OBJECT_MAX * objects;
      if (result.measured < floor) {
        problems.push(`${gateId} passed while reporting ${result.measured} resolution(s) for ${objects} `
          + `object(s); every object must cost at least one, and a total below ${floor} means some object's `
          + 'bytes did not come from a resolution this run made — a zero means the provider was never '
          + 'contacted at all');
      }
      if (result.measured > ceiling) {
        problems.push(`${gateId} passed while reporting ${result.measured} resolution(s) for ${objects} `
          + `object(s); access material is valid for hours and every read after the first must reuse it, so `
          + `more than ${ceiling} is a resolution storm against a metered endpoint`);
      }
      continue;
    }

    // §5 GIVES THREE CLAIMS A SECOND BUDGET, AND A BUDGET NOTHING READS IS A BUDGET NOTHING CAN MOVE.
    //
    // THEY ARE CHECKED HERE, BEFORE THE SINGLE-CEILING PATH, because the pair on the result is one number
    // and §5's column names two. `P13-A7` is measured against `HOST_SET_LOSSES_MAX` AND `RESIDUE_MAX`: a
    // name that was there before and is gone after is a LOSS, a mountpoint or a run directory this run
    // created and left behind is a RESIDUE, and "left as it was found" is broken in both directions.
    // `P13-S1` and `P13-S2` are each measured against a ceiling on skips AND a floor on runs — and every
    // ceiling in this contract is satisfied by ONE run, so without the floor "three consecutive fresh" is a
    // title rather than a measurement.
    if (gateId.startsWith('P13-A7-')) {
      if (typeof result.residueSurviving !== 'number') {
        problems.push(`${gateId} passed without recording how much of this run survived on the host; §5.1 `
          + 'measures it against RESIDUE_MAX as well as against the set losses, and a residue nobody counted '
          + 'is not a zero');
        continue;
      }
      if (result.residueSurviving > PHASE13_RULES.RESIDUE_MAX) {
        problems.push(`${gateId} passed while reporting ${result.residueSurviving} surviving artefact(s) `
          + `against a residue budget of ${PHASE13_RULES.RESIDUE_MAX}; a set loss of zero says nothing about `
          + 'what the run left behind');
        continue;
      }
    }
    if (gateId.startsWith('P13-S1-') || gateId.startsWith('P13-S2-')) {
      if (typeof result.consecutiveFreshRuns !== 'number') {
        problems.push(`${gateId} passed without recording how many consecutive fresh runs it counted; zero `
          + 'skips out of a number nobody recorded is not three consecutive fresh runs');
        continue;
      }
      if (result.consecutiveFreshRuns < PHASE13_RULES.CONSECUTIVE_FRESH_RUNS) {
        problems.push(`${gateId} passed while reporting ${result.consecutiveFreshRuns} consecutive fresh `
          + `run(s) and §5 asks for ${PHASE13_RULES.CONSECUTIVE_FRESH_RUNS}; two of three is not two thirds `
          + 'of three, and a floor is not satisfied by a ceiling');
        continue;
      }
    }

    const key = phase13BudgetKeyFor(gateId);
    if (key === undefined) {
      if (result.measured !== undefined || result.budget !== undefined) {
        problems.push(`${gateId} reports a measurement against a budget §5.3 does not give it`);
      }
      continue;
    }
    const budget = PHASE13_RULES[key];
    if (result.budget !== budget) {
      problems.push(`${gateId} was measured against ${String(result.budget)} rather than against the `
        + `contract's ${String(budget)}, so the verdict is against a budget this phase did not set`);
      continue;
    }
    if (typeof result.measured !== 'number') {
      problems.push(`${gateId} passed without recording what it measured`);
      continue;
    }
    if (result.measured > budget) {
      problems.push(`${gateId} passed while reporting ${result.measured} against a budget of ${budget}`);
    }
  }

  return problems;
}

/** True only when nothing is wrong. The only place a boolean is derived from the list. */
export function phase13Closed(results: Phase13Results): boolean {
  return phase13ClosureProblems(results).length === 0;
}

// ---------------------------------------------------------------------------------------------------------
// §6 — the entry criteria, as a function that refuses rather than as a checklist somebody ticks
// ---------------------------------------------------------------------------------------------------------

/**
 * What is known about the state a run would start from.
 *
 * EVERY FIELD IS OPTIONAL AND EVERY ABSENT ONE IS A REFUSAL. That is deliberate and it is the whole design:
 * the failure mode of an entry gate is not a criterion answered wrongly, it is a criterion nobody filled in
 * — and a required field with a permissive default is a field a caller can forget. `undefined` is refused by
 * name, with the same weight as `false`.
 */
export interface Phase13EntryState {
  /** E1 — the commit carrying the contract precedes every run record commit. */
  readonly contractCommitted?: boolean;
  /** E2 — Phase 12's §12.1 supersession is enacted in Phase 12's own document. */
  readonly phase12Amended?: boolean;
  /** E3 — the candidate commit, frozen and staged byte-identically both ways. */
  readonly candidate?: string;
  readonly stagedFilesDiffering?: number;
  readonly stagedTextFilesWithCarriageReturn?: number;
  /**
   * E3 — how many repairs the candidate carries that no control fails on.
   *
   * THIS IS THE FIELD `REPAIRS_WITHOUT_A_CONTROL_MAX` IS READ THROUGH, and it exists because a threshold
   * nothing can move is the D3 defect the pre-entry tranche found in `P13PRE-C3` and repaired for itself.
   * The rule is this module's own: a defect found on the way to a run is repaired WITH a control that fails
   * on the unrepaired bytes, and a repair nobody proved is a repair whose defect can come back green.
   */
  readonly repairsWithoutAControlInCandidate?: number;
  /** E4 — the complete Phase 12 provider-free sequence, from THIS candidate. */
  readonly phase12SequencesFromThisCandidate?: number;
  readonly phase12SkipsInThoseSequences?: number;
  /** E5 — the operator's four inputs, by presence and shape only. Never a value. */
  readonly operatorInputsPresent?: boolean;
  readonly operatorSecretsDistinctAndRestricted?: boolean;
  readonly operatorConfirmedEntitledObjectByReference?: boolean;
  /** E6 — the allowlist, by count and digest only. Never a member. */
  readonly allowlistRecordTaken?: boolean;
  readonly allowedOriginCount?: number;
  /** E7 — the origin recheck's exit status, inside the hour before the sequence. */
  readonly originRecheckExitStatus?: number;
  readonly originRecheckAgeMinutes?: number;
  /** E8 — the host, measured immediately before the run rather than read out of an earlier record. */
  readonly otherGateCampaignRunning?: boolean;
  readonly projectionContainersOnHost?: number;
  readonly gatePortsFree?: boolean;
  readonly baselineTakenImmediatelyBefore?: boolean;
  /** E9 — the origin-stability plan, evaluated by the pre-entry module's own function. */
  readonly originPlan?: OriginStabilityPlan;
}

/**
 * Every reason a Phase 13 run may not start, as sentences. Empty means every criterion is met.
 *
 * IT IS NOT AN AUTHORISATION EVEN WHEN IT IS EMPTY. An empty list says the criteria this repository can
 * check are met; contacting a provider is the operator's decision and needs the operator's own window.
 */
export function phase13EntryRefusals(state: Phase13EntryState): readonly string[] {
  const refusals: string[] = [];
  // EVERY REFUSAL NAMES THE FIELD IT IS ABOUT, NOT JUST THE CRITERION.
  //
  // WHY, AND IT WAS FOUND BY RUNNING THIS FUNCTION RATHER THAN BY READING IT. Several criteria are carried by
  // more than one field — E5 by three, E8 by four — and a message built only from the criterion label
  // produced TWO IDENTICAL SENTENCES for two different unevaluated things. A reader working through the list
  // cannot tell which field to go and fill in, and a list with a repeated line reads as a rendering bug
  // rather than as two findings. The field name is what makes each refusal actionable.
  const required = (value: boolean | undefined, criterion: string, field: string, sentence: string): void => {
    if (value === undefined) {
      refusals.push(`${criterion} (${field}) was not evaluated, and an unevaluated criterion is not a `
        + 'satisfied one');
      return;
    }
    if (!value) refusals.push(`${criterion} (${field}): ${sentence}`);
  };
  const count = (value: number | undefined, criterion: string, field: string, sentence: string, max = 0): void => {
    if (typeof value !== 'number') {
      refusals.push(`${criterion} (${field}) was not measured, and an unmeasured figure is not a zero`);
      return;
    }
    if (value > max) refusals.push(`${criterion} (${field}): ${sentence} (${value}, budget ${max})`);
  };

  required(state.contractCommitted, 'E1', 'contractCommitted',
    'the Phase 13 contract is not committed, so the run would choose the claims it is measured by');
  required(state.phase12Amended, 'E2', 'phase12Amended',
    'Phase 12 §12.1\'s two superseded sentences are not amended in Phase 12\'s own document');

  if (state.candidate === undefined || !/^[0-9a-f]{7,40}$/.test(state.candidate)) {
    refusals.push('E3: no frozen candidate commit is named, so no figure this run produces belongs to a tree');
  }
  count(state.stagedFilesDiffering, 'E3', 'stagedFilesDiffering', 'the staged tree is not byte-identical to the candidate');
  count(state.stagedTextFilesWithCarriageReturn, 'E3', 'stagedTextFilesWithCarriageReturn',
    'text files carrying a carriage return reached the host, so the tree there is not the commit');
  count(state.repairsWithoutAControlInCandidate, 'E3', 'repairsWithoutAControlInCandidate',
    'the candidate carries a repair that no control fails on, so nothing says the defect is gone rather '
    + 'than merely quiet', PHASE13_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX);

  if (typeof state.phase12SequencesFromThisCandidate !== 'number') {
    refusals.push('E4 was not measured: how many complete Phase 12 provider-free sequences have run from '
      + 'THIS candidate is the question, and an unmeasured count is not three');
  } else if (state.phase12SequencesFromThisCandidate < PHASE13_RULES.CONSECUTIVE_FRESH_RUNS) {
    refusals.push(`E4: the candidate carries ${state.phase12SequencesFromThisCandidate} complete Phase 12 `
      + `sequence(s) and §6 asks for ${PHASE13_RULES.CONSECUTIVE_FRESH_RUNS}. Phase 12's GO is a closed `
      + 'record about the commit it was measured from and does not transfer to a descendant that moved the '
      + 'staging script, the gates or the suites');
  }
  count(state.phase12SkipsInThoseSequences, 'E4', 'phase12SkipsInThoseSequences', 'a Phase 12 sequence skipped an arm, and a skip is not a pass');

  required(state.operatorInputsPresent, 'E5', 'operatorInputsPresent',
    'the operator has not placed all four inputs, so the gate would exit 77 having contacted nothing');
  required(state.operatorSecretsDistinctAndRestricted, 'E5', 'operatorSecretsDistinctAndRestricted',
    'the two secret files are not both mode 0600 and different values; equal values would put the account '
    + 'credential in the daemon that talks to arbitrary provider-supplied hosts');
  required(state.operatorConfirmedEntitledObjectByReference, 'E5', 'operatorConfirmedEntitledObjectByReference',
    'no entitled object has been confirmed by the operator, and Phase 13 never lists an account');

  required(state.allowlistRecordTaken, 'E6', 'allowlistRecordTaken',
    'no no-contact readiness record has been taken, so there is no before to compare an after against');
  if (typeof state.allowedOriginCount !== 'number' || state.allowedOriginCount < 1) {
    refusals.push('E6: the origin allowlist admits no member this run could be served from, and widening it '
      + 'is a BLOCKER rather than a step');
  }

  // E6 AND E9 CARRY TWO COPIES OF ONE FACT, AND NOTHING USED TO ASSERT THEY AGREE.
  //
  // FOUND BY RUNNING THIS FUNCTION RATHER THAN BY READING IT, on the campaign's own real figures. E6 reads
  // `allowedOriginCount` and E9 reads `originPlan.allowedOriginCount`. Filling the plan's copy in as the
  // OBSERVED POOL SIZE rather than as the allowlist's count made §14.3's six-against-seven refusal — the one
  // that document calls "the one that matters most" — DISAPPEAR, and `phase13MayEnter` returned true with an
  // empty list. No provider fact had to move; one field was filled in inconsistently, and the gate
  // authorised entry. That is precisely the drift this module's header warns about, in precisely the
  // direction that lets a run start.
  //
  // IT IS REFUSED RATHER THAN RECONCILED. Picking one of the two numbers here would be this module deciding
  // which of the operator's measurements is the real one, and the pool comparison §8 turns on would then be
  // made against a number nobody took.
  if (state.originPlan !== undefined
    && typeof state.allowedOriginCount === 'number'
    && typeof state.originPlan.allowedOriginCount === 'number'
    && state.allowedOriginCount !== state.originPlan.allowedOriginCount) {
    refusals.push('E6/E9 (allowedOriginCount, originPlan.allowedOriginCount): the allowlist is described as '
      + `admitting ${state.allowedOriginCount} member(s) by the readiness record and `
      + `${state.originPlan.allowedOriginCount} by the origin-stability plan. They are two copies of ONE `
      + 'fact and they disagree, so at least one of them is not a measurement, and the pool comparison §8 '
      + 'turns on would be made against a number nobody took');
  }

  if (typeof state.originRecheckExitStatus !== 'number') {
    refusals.push('E7 was not measured: the origin recheck was not run, and not measured is not allowed');
  } else {
    const disposition = originRotationDisposition(state.originRecheckExitStatus);
    if (disposition === 'abort-origin-rotated') {
      refusals.push('E7: the serving origin is outside the allowlist. This is a BLOCKER, escalated as a '
        + 'count and a digest, and it is NEVER resolved by editing the allowlist to make a run go green');
    } else if (disposition !== 'proceed') {
      refusals.push(`E7: the origin recheck answered ${state.originRecheckExitStatus}, which means NOT `
        + 'MEASURED. An unevaluated policy is not a satisfied one');
    }
  }
  if (typeof state.originRecheckAgeMinutes !== 'number') {
    refusals.push('E7 was not measured: how long ago the recheck ran is the question, and a recheck of '
      + 'unknown age is an answer about a different origin');
  } else if (state.originRecheckAgeMinutes > PHASE13_RULES.ORIGIN_RECORD_MAX_AGE_MINUTES) {
    refusals.push(`E7: the origin recheck is ${state.originRecheckAgeMinutes} minutes old and §8 allows `
      + `${PHASE13_RULES.ORIGIN_RECORD_MAX_AGE_MINUTES}`);
  }

  if (state.otherGateCampaignRunning === undefined) {
    refusals.push('E8 was not evaluated: whether another gate campaign is on the host is the question, and '
      + 'two concurrent runs bind the same loopback ports and fail in a way that reads like a gate defect');
  } else if (state.otherGateCampaignRunning) {
    refusals.push('E8: another gate campaign is running on the host');
  }
  count(state.projectionContainersOnHost, 'E8', 'projectionContainersOnHost',
    'the host already carries projection containers, so this run would inherit a namespace');
  required(state.gatePortsFree, 'E8', 'gatePortsFree', 'the gate\'s ports are not free');
  required(state.baselineTakenImmediatelyBefore, 'E8', 'baselineTakenImmediatelyBefore',
    'the before-baseline was not taken immediately before the run; a sampled fact paired with a fresh one '
    + 'invents an instant');

  if (state.originPlan === undefined) {
    refusals.push('E9 was not evaluated: no origin-stability plan was supplied, and an unmeasured origin '
      + 'lifetime is not a generous one');
  } else {
    // THE PLAN'S TWO COUNTS ARE REFUSED HERE RATHER THAN INSIDE `originStabilityRefusals`, AND THAT IS NOT A
    // PREFERENCE. `phase13-preentry.ts` is on `PHASE13_FORBIDDEN_SOURCE` and §4's ninth refusal forbids this
    // tranche from editing the instrument it is measured through, so the missing refusals are added at the
    // one site this tranche owns — E9's own — and the imported function is left byte-identical.
    //
    // WHAT IT MISSES, MEASURED RATHER THAN READ. `originStabilityRefusals` guards its pool comparison with
    // `typeof allowed === 'number' && typeof pool === 'number'`, so an ABSENT `observedPoolSize`, or an
    // absent plan-side `allowedOriginCount`, produces NO refusal at all — while an unmeasured lifetime, an
    // unbounded duration and an ageless record are each refused there by name. The pool was the one field in
    // that function where NOT MEASURED read as satisfied, and §8's own sentence is the opposite: not
    // measured is not allowed.
    //
    // A ZERO IS STILL A MEASUREMENT AND IS NOT REFUSED HERE. What is refused is an absent, an infinite, a
    // NaN and a negative count — none of which is a number of origins anybody observed.
    const planCount = (value: number | undefined, field: string, sentence: string): void => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        refusals.push(`E9 (originPlan.${field}) was not measured: ${sentence}, and an unmeasured pool is `
          + 'not a small one');
      }
    };
    planCount(state.originPlan.observedPoolSize, 'observedPoolSize',
      'how many distinct origins the pool was observed serving from is the question §8 turns on');
    planCount(state.originPlan.allowedOriginCount, 'allowedOriginCount',
      'the plan carries no allowlist count for an observed pool to be compared against');
    for (const reason of originStabilityRefusals(state.originPlan)) refusals.push(`E9: ${reason}`);
  }

  return refusals;
}

/**
 * True only when every entry criterion passes.
 *
 * IT IS NOT AN AUTHORISATION. It says the criteria this repository can check are met. Contacting a provider
 * is the operator's decision, in the operator's own window, against the operator's own metered account.
 */
export function phase13MayEnter(state: Phase13EntryState): boolean {
  return phase13EntryRefusals(state).length === 0;
}

// ---------------------------------------------------------------------------------------------------------
// §7 — the exit criteria, as a function rather than as six labels
// ---------------------------------------------------------------------------------------------------------

/**
 * The facts §7 asks about that a result set cannot carry.
 *
 * WHY THIS INTERFACE EXISTS AT ALL. §13's ownership row says this module carries "§6's entry criteria and
 * §7's exit criteria, as code". §6 had `phase13EntryRefusals`; §7 had `PHASE13_EXIT_CRITERIA` — SIX STRINGS —
 * and a suite that asserted each label has a row in the document. X3 and X5 had no executable counterpart at
 * all, so half of that ownership sentence was a label rather than a claim. Every field here is optional and
 * every absent one is a refusal, for the same reason every one of §6's is.
 */
export interface Phase13ExitState {
  /** X1 — the wrapper's own three answers, rather than a sentence about them. */
  readonly wrapperRunsCompleted?: number;
  readonly wrapperRunsSkipped?: number;
  readonly wrapperExitStatus?: number;
  /** X1 — one frozen candidate, named, and the same one all three runs ran from. */
  readonly candidate?: string;
  /**
   * X3 — the two refusals §4 opens with, as facts about what happened rather than as intentions.
   *
   * THEY ARE STATED IN THE FAILING DIRECTION ON PURPOSE. An absent `credentialReadPrintedOrChanged` is
   * refused, `true` is refused, and only an explicit `false` passes — so nobody discharges X3 by leaving a
   * field out.
   */
  readonly credentialReadPrintedOrChanged?: boolean;
  readonly providerOutageInduced?: boolean;
  /** X4 — the before and after readiness records, compared by digest rather than by count alone. */
  readonly allowlistWholeFileDigestUnchanged?: boolean;
  readonly allowlistMemberDigestsUnchanged?: boolean;
  readonly allowlistMembersMoved?: number;
  /** X5 — the host, as the set arithmetic §5.1 gives `P13-A7`, plus what survived. */
  readonly hostSetLosses?: number;
  readonly residueSurviving?: number;
  readonly applianceUntouched?: boolean;
  /**
   * X6 — the non-vacuity control.
   *
   * `phase13ClosureProblems` returning empty is half of X6. The other half is the same evidence with ONE
   * BYTE CHANGED still being refused, because a function that returns empty for everything returns empty for
   * a real run too.
   */
  readonly tamperedEvidenceStillRefused?: boolean;
}

/**
 * Every reason a Phase 13 GO may not be recorded, as sentences. Empty means §7 is satisfied.
 *
 * IT IS NOT A GO EVEN WHEN IT IS EMPTY, for the same reason `phase13MayEnter` is not an authorisation: it
 * says the criteria this repository can check are met over the evidence it was handed.
 */
export function phase13ExitRefusals(results: Phase13Results, state: Phase13ExitState): readonly string[] {
  const refusals: string[] = [];
  const required = (value: boolean | undefined, criterion: string, field: string, sentence: string): void => {
    if (value === undefined) {
      refusals.push(`${criterion} (${field}) was not evaluated, and an unevaluated criterion is not a `
        + 'satisfied one');
      return;
    }
    if (!value) refusals.push(`${criterion} (${field}): ${sentence}`);
  };
  const ceiling = (value: number | undefined, criterion: string, field: string, sentence: string,
    max: number): void => {
    if (typeof value !== 'number') {
      refusals.push(`${criterion} (${field}) was not measured, and an unmeasured figure is not a zero`);
      return;
    }
    if (value > max) refusals.push(`${criterion} (${field}): ${sentence} (${value}, budget ${max})`);
  };

  // X1 — THE WRAPPER'S OWN THREE RUNS, as the three numbers it produces rather than as a sentence.
  if (typeof state.wrapperRunsCompleted !== 'number') {
    refusals.push('X1 (wrapperRunsCompleted) was not measured: how many of the three runs completed is the '
      + 'question, and an unmeasured count is not three');
  } else if (state.wrapperRunsCompleted < PHASE13_RULES.CONSECUTIVE_FRESH_RUNS) {
    refusals.push(`X1 (wrapperRunsCompleted): ${state.wrapperRunsCompleted} run(s) completed and §7 asks `
      + `for ${PHASE13_RULES.CONSECUTIVE_FRESH_RUNS}; two of three is not two thirds of three`);
  }
  ceiling(state.wrapperRunsSkipped, 'X1', 'wrapperRunsSkipped',
    'a run was skipped, and 77 is a skip rather than a pass', PHASE13_RULES.SKIPPED_RUNS_MAX);
  if (state.wrapperExitStatus !== 0) {
    refusals.push(`X1 (wrapperExitStatus): the wrapper answered ${String(state.wrapperExitStatus)} rather `
      + 'than 0, and any other status is a sequence this record may not read as three');
  }
  if (state.candidate === undefined || !/^[0-9a-f]{7,40}$/.test(state.candidate)) {
    refusals.push('X1 (candidate): no frozen candidate is named, so the three runs do not belong to one tree');
  }

  // X2 — EVERY TIER A CLAIM, FROM A REAL-MODE RUN. It is read off the result set rather than declared,
  // because a declaration about verdicts is a second copy of the verdicts and the two can disagree.
  if (results.mode !== 'real') {
    refusals.push('X2: the run reports mode ' + String(results.mode) + ', and no Tier A verdict may be '
      + 'recorded from a provider-free rehearsal');
  }
  for (const gateId of PHASE13_ACCEPTANCE_GATE_IDS) {
    const found = results.results.filter((one) => one.gate === gateId);
    if (found.length === 0) {
      refusals.push(`X2 (${gateId}): no verdict, and an absent verdict is not a pass`);
      continue;
    }
    if (found.length > 1) {
      refusals.push(`X2 (${gateId}): more than one verdict, so it is not clear which one is the run's`);
      continue;
    }
    if (found[0]!.verdict !== 'pass') {
      refusals.push(`X2 (${gateId}): the verdict is ${found[0]!.verdict}, and a skip is not a pass`);
    }
  }

  // X3 — THE TWO REFUSALS §4 OPENS WITH.
  if (state.credentialReadPrintedOrChanged === undefined) {
    refusals.push('X3 (credentialReadPrintedOrChanged) was not evaluated, and an unevaluated criterion is '
      + 'not a satisfied one');
  } else if (state.credentialReadPrintedOrChanged) {
    refusals.push('X3 (credentialReadPrintedOrChanged): a credential was read, printed, written into '
      + 'evidence, rotated or changed, which the first refusal of §4 forbids outright');
  }
  if (state.providerOutageInduced === undefined) {
    refusals.push('X3 (providerOutageInduced) was not evaluated, and an unevaluated criterion is not a '
      + 'satisfied one');
  } else if (state.providerOutageInduced) {
    refusals.push('X3 (providerOutageInduced): an outage was induced, simulated, provoked or waited for, '
      + 'which the fourth refusal of §4 forbids and which is the claim of Phase 11 tier two rather than of '
      + 'this phase');
  }

  // X4 — THE ALLOWLIST, BY DIGEST AND BY COUNT.
  required(state.allowlistWholeFileDigestUnchanged, 'X4', 'allowlistWholeFileDigestUnchanged',
    'the whole-file digest of the allowlist moved across the sequence');
  required(state.allowlistMemberDigestsUnchanged, 'X4', 'allowlistMemberDigestsUnchanged',
    'a member digest moved, so the allowlist is not the one the run started against');
  ceiling(state.allowlistMembersMoved, 'X4', 'allowlistMembersMoved',
    'a member moved, and a widening made to turn a run green is a BLOCKER rather than a step',
    PHASE13_RULES.ALLOWLIST_MEMBERS_MOVED_MAX);

  // X5 — THE HOST, IN BOTH DIRECTIONS. A count is satisfied by a removal and a creation, so the losses and
  // the survivors are two measurements rather than one.
  ceiling(state.hostSetLosses, 'X5', 'hostSetLosses',
    'a container, network or volume that was there before is gone after', PHASE13_RULES.HOST_SET_LOSSES_MAX);
  ceiling(state.residueSurviving, 'X5', 'residueSurviving',
    'a mountpoint, a run directory or another artefact of this run survives', PHASE13_RULES.RESIDUE_MAX);
  required(state.applianceUntouched, 'X5', 'applianceUntouched',
    'the container, network or mount point of the appliance moved, and one mount point keeps exactly one '
    + 'owner');

  // X6 — THE CLOSURE FUNCTION, AND THE PROOF THAT ITS GREEN IS NOT VACUOUS.
  const problems = phase13ClosureProblems(results);
  if (problems.length > 0) {
    refusals.push(`X6: phase13ClosureProblems returns ${problems.length} problem(s) over the run's own `
      + `verdicts, the first being: ${problems[0]}`);
  }
  required(state.tamperedEvidenceStillRefused, 'X6', 'tamperedEvidenceStillRefused',
    'the same evidence with one byte changed was not shown to be refused, so the green is a green nobody '
    + 'has shown to be about anything');

  return refusals;
}

/**
 * True only when every exit criterion passes.
 *
 * IT IS NOT A GO. A GO is written by a person, into a run record, from evidence.
 */
export function phase13ExitSatisfied(results: Phase13Results, state: Phase13ExitState): boolean {
  return phase13ExitRefusals(results, state).length === 0;
}

// ---------------------------------------------------------------------------------------------------------
// The sentences a summary may not grow past
// ---------------------------------------------------------------------------------------------------------

/** §2.3's ceiling sentence, held as a constant so a summary that grew past it has to edit a module. */
export const PHASE13_CEILING_SENTENCE =
  'one provider, one host, one half of the mixed path; no Usenet, no media server, no outage, no soak';

/** §2.3's meaning, in one sentence, for the same reason. */
export const PHASE13_MEANING =
  'the operator\'s own entitled objects were published as a generation, resolved by the operator\'s own '
  + 'account, and read back byte-correct through a read-only FUSE mount on the operator\'s own host, three '
  + 'consecutive fresh times from one frozen candidate — with the API key never inside the daemon '
  + 'container, the origin allowlist unmoved, and the host left as it was found.';

/** §2.1's seven sentences. The suite asserts the document still carries every one of them word for word. */
export const PHASE13_PRESERVED_STATES = Object.freeze([
  'Phase 10 is GO and Phase 13 does not touch it',
  'Phase 11 tier one is GO and Phase 13 does not touch it',
  'Phase 12 is GO from candidate a8d7232 and Phase 13 does not touch that record',
  'Phase 9 stays OPEN, and none of P9-2, P9-3, P9-5 or P9-11 is answered here',
  'Phase 11 tier two stays OPEN, and P11-R1 is NOT RUN and has no half to close',
  'Phase 14 is NOT ENTERED and no Usenet or media-server claim is closed',
  'a Phase 13 GO is one half of one path on one host, and is not the mixed product',
]);

/** §2.4's non-claims, so a summary cannot grow one. */
export const PHASE13_NONCLAIMS = Object.freeze([
  'the mixed product', 'Usenet', 'a media-server acceptance', 'a provider outage', 'a soak', 'a load test',
  'an uptime claim', 'an availability claim', 'a second host', 'high availability', 'a production release',
  'Real-Debrid', 'instant Usenet streaming', 'automatic source failover', 'indexer search',
  'a download-selection policy',
]);

/**
 * The paths Phase 13 is forbidden to modify.
 *
 * IT IS THE PRE-ENTRY TRANCHE'S LIST PLUS ITS OWN MODULE, PLUS THE INSTRUMENT. A tranche that could edit the
 * gate it is measured THROUGH is a tranche whose measurement concludes whatever it needs to — and a gate
 * repaired mid-campaign is a gate the campaign did not survive. A defect found during a run stops the run,
 * is repaired with a control, and the series restarts at one from a new candidate.
 */
export const PHASE13_FORBIDDEN_SOURCE: readonly string[] = Object.freeze([
  'deploy/projection-alpha.sh',
  'deploy/projection-content.sh',
  'deploy/projection-gate-cleanup.sh',
  'deploy/projectiond-alpha.env.example',
  'docker-compose.projection-alpha.yml',
  'src/ops/projection-content.ts',
  'src/ops/projection-content-cli.ts',
  'src/core/projection/phase7.ts',
  'src/core/projection/phase8.ts',
  'src/core/projection/phase9.ts',
  'src/core/projection/phase10.ts',
  'src/core/projection/phase11.ts',
  'src/core/projection/phase12.ts',
  'src/core/projection/phase13-preentry.ts',
]);

/**
 * THE PATHS THIS TRANCHE CREATES OR MODIFIES THAT DO NOT NAME A PROVIDER.
 *
 * WHY THIS LIST IS DELIBERATELY NOT THE WHOLE LIST, AND WHERE THE REST IS. Several of the scripts and suites
 * this tranche touches carry the provider's name in their FILENAME. All eight provider source allowlists
 * under `test/` walk `src/` and refuse any unlisted file that names the provider at all, and Phase 11 §6.2
 * records what widening them costs. So the COMPLETE ownership list lives in the phase document's §13 table,
 * which is the ownership record anyway, and `test/projection-phase13.ts` parses that table, unions it with
 * this list, and runs `phase9RequiresSoakRerun` over the UNION. The soak question is asked of everything, and
 * no security boundary moved for a filename.
 */
export const PHASE13_TRANCHE_PATHS: readonly string[] = Object.freeze([
  'docs/PROJECTION_PHASE_13_REAL_PROVIDER_ACCEPTANCE.md',
  'src/core/projection/phase13.ts',
  'test/projection-phase13.ts',
  'docs/PROJECTION_PHASE_12_AUDIT_AND_PROVIDER_FREE_CLOSURE.md',
  'docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md',
  'deploy/projection-real-provider-gate.sh',
  'test/projection-phase13-preentry.ts',
  'test/projection-phase13-preentry-gate-audit.ts',
  'test/projection-real-provider.ts',
  'test/suite-inventory.json',
  'package.json',
]);

/**
 * The heading of the document section that carries the COMPLETE ownership list.
 *
 * Held as a constant so the suite cannot drift from the section it parses, and so a renamed section fails
 * loudly rather than quietly parsing nothing and reporting that nothing triggers a soak.
 */
export const PHASE13_OWNERSHIP_SECTION = '## 13. File ownership — every path this tranche touches';

/** §6's criteria, by label, so the document and the function cannot name different ones. */
export const PHASE13_ENTRY_CRITERIA = Object.freeze([
  'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9',
]);

/** §7's criteria, by label, for the same reason. */
export const PHASE13_EXIT_CRITERIA = Object.freeze([
  'X1', 'X2', 'X3', 'X4', 'X5', 'X6',
]);
