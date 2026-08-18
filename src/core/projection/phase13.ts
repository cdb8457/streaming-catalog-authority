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
 * The budget a claim is measured against, or `undefined` where §5 gives it none.
 *
 * A CLAIM WITH NO BUDGET HAS NOTHING TO MEASURE, and a run that supplies a measurement for one has invented
 * a budget. `phase13ClosureProblems` refuses both directions, which is Phase 11's rule and Phase 12's.
 */
export function phase13BudgetKeyFor(gate: string): Phase13RuleKey | undefined {
  if (gate.startsWith('P13-A1-')) return 'PREFLIGHT_CONTACTS_MAX';
  if (gate.startsWith('P13-A3-')) return 'READ_MISMATCHES_MAX';
  if (gate.startsWith('P13-A5-')) return 'SECRET_TRACES_MAX';
  if (gate.startsWith('P13-A6-')) return 'WRITE_PATHS_ADMITTED_MAX';
  if (gate.startsWith('P13-A7-')) return 'HOST_SET_LOSSES_MAX';
  if (gate.startsWith('P13-A8-')) return 'ALLOWLIST_MEMBERS_MOVED_MAX';
  if (gate.startsWith('P13-S1-')) return 'SKIPPED_RUNS_MAX';
  if (gate.startsWith('P13-S3-')) return 'REQUIRED_BUT_SKIPPED_MAX';
  // `P13-A2` and `P13-S2` have nothing to count; `P13-A4` is the one claim measured against a RANGE, and it
  // is handled on its own below rather than squeezed into a single-ceiling shape that would drop its floor.
  return undefined;
}

export interface Phase13GateResult {
  readonly gate: string;
  readonly verdict: 'pass' | 'fail' | 'skip';
  readonly measured?: number;
  readonly budget?: number;
  /** `P13-A4` only: how many objects the measurement is per. A ratio with no denominator is a number. */
  readonly perObjectDenominator?: number;
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
  const required = (value: boolean | undefined, criterion: string, sentence: string): void => {
    if (value === undefined) {
      refusals.push(`${criterion} was not evaluated, and an unevaluated criterion is not a satisfied one`);
      return;
    }
    if (!value) refusals.push(`${criterion}: ${sentence}`);
  };
  const count = (value: number | undefined, criterion: string, sentence: string, max = 0): void => {
    if (typeof value !== 'number') {
      refusals.push(`${criterion} was not measured, and an unmeasured figure is not a zero`);
      return;
    }
    if (value > max) refusals.push(`${criterion}: ${sentence} (${value}, budget ${max})`);
  };

  required(state.contractCommitted, 'E1',
    'the Phase 13 contract is not committed, so the run would choose the claims it is measured by');
  required(state.phase12Amended, 'E2',
    'Phase 12 §12.1\'s two superseded sentences are not amended in Phase 12\'s own document');

  if (state.candidate === undefined || !/^[0-9a-f]{7,40}$/.test(state.candidate)) {
    refusals.push('E3: no frozen candidate commit is named, so no figure this run produces belongs to a tree');
  }
  count(state.stagedFilesDiffering, 'E3', 'the staged tree is not byte-identical to the candidate');
  count(state.stagedTextFilesWithCarriageReturn, 'E3',
    'text files carrying a carriage return reached the host, so the tree there is not the commit');

  if (typeof state.phase12SequencesFromThisCandidate !== 'number') {
    refusals.push('E4 was not measured: how many complete Phase 12 provider-free sequences have run from '
      + 'THIS candidate is the question, and an unmeasured count is not three');
  } else if (state.phase12SequencesFromThisCandidate < PHASE13_RULES.CONSECUTIVE_FRESH_RUNS) {
    refusals.push(`E4: the candidate carries ${state.phase12SequencesFromThisCandidate} complete Phase 12 `
      + `sequence(s) and §6 asks for ${PHASE13_RULES.CONSECUTIVE_FRESH_RUNS}. Phase 12's GO is a closed `
      + 'record about the commit it was measured from and does not transfer to a descendant that moved the '
      + 'staging script, the gates or the suites');
  }
  count(state.phase12SkipsInThoseSequences, 'E4', 'a Phase 12 sequence skipped an arm, and a skip is not a pass');

  required(state.operatorInputsPresent, 'E5',
    'the operator has not placed all four inputs, so the gate would exit 77 having contacted nothing');
  required(state.operatorSecretsDistinctAndRestricted, 'E5',
    'the two secret files are not both mode 0600 and different values; equal values would put the account '
    + 'credential in the daemon that talks to arbitrary provider-supplied hosts');
  required(state.operatorConfirmedEntitledObjectByReference, 'E5',
    'no entitled object has been confirmed by the operator, and Phase 13 never lists an account');

  required(state.allowlistRecordTaken, 'E6',
    'no no-contact readiness record has been taken, so there is no before to compare an after against');
  if (typeof state.allowedOriginCount !== 'number' || state.allowedOriginCount < 1) {
    refusals.push('E6: the origin allowlist admits no member this run could be served from, and widening it '
      + 'is a BLOCKER rather than a step');
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
  count(state.projectionContainersOnHost, 'E8',
    'the host already carries projection containers, so this run would inherit a namespace');
  required(state.gatePortsFree, 'E8', 'the gate\'s ports are not free');
  required(state.baselineTakenImmediatelyBefore, 'E8',
    'the before-baseline was not taken immediately before the run; a sampled fact paired with a fresh one '
    + 'invents an instant');

  if (state.originPlan === undefined) {
    refusals.push('E9 was not evaluated: no origin-stability plan was supplied, and an unmeasured origin '
      + 'lifetime is not a generous one');
  } else {
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
