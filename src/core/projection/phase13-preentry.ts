import { PHASE12_RULES } from './phase12.js';

// Projection Phase 13 PRE-ENTRY — the instrument repair's rules, as code rather than as prose.
//
// WHAT THIS IS, IN ONE SENTENCE. It is NOT Phase 13. Phase 13 is a run against a real provider account on the
// operator's own machine, and this module contains no claim that could be answered by one. This is the
// bounded repair of the INSTRUMENT that a later, separately authorised Phase 13 would have to use — every
// claim below is answerable offline, from the shipped bytes and from the provider-free path, and a repair
// whose evidence would need a packet is out of scope by construction.
//
// WHY IT HAS ITS OWN NAMESPACE RATHER THAN BORROWING PHASE 13's. An independent readiness review named nine
// blockers, and the tempting shape is to open `P13-A1…A9` now and fill them in later. That shape is how a
// claim id acquires a verdict from work that did not answer it: the id exists, something green is recorded
// against it, and by the time the real run happens the id is already spoken for. So the pre-entry work gets
// ids of its own — `P13PRE-*` — which cannot be mistaken for Phase 13's, cannot be promoted into Phase 13's,
// and say in their own names that they are about an instrument rather than about a provider.
//
// WHAT IT DOES NOT MOVE, AND THIS IS THE FIRST LINE OF ITS RECORD. Phase 10, Phase 11 tier one and Phase 12
// are GO and stay exactly as they are; Phase 9's open claims and Phase 11 TIER TWO stay exactly as OPEN as
// they were. In particular `P11-R1` is NOT RUN, is not half-run, and has no provider half to close — it is a
// conjunction about two kinds of entry sharing ONE published generation, and a conjunction about co-residency
// has no half. Nothing in this module can express one, which is the point.
//
// IT NAMES NO PROVIDER, imports no gate, touches no filesystem and contacts nothing — so, like `phase12.ts`
// before it, no source allowlist has to be widened for it. The provider is named in the phase document and in
// the suites, which is where a filename that names one already belongs.

/**
 * The thresholds.
 *
 * SIX ARE NEW AND TWO ARE IMPORTED. Every new one is a number the readiness review's findings turned into a
 * question a suite can ask of the shipped bytes; every imported one is read from the module of the tranche it
 * came from, so it cannot drift here in the passing direction.
 */
export const PHASE13_PREENTRY_RULES = Object.freeze({
  /**
   * NEW. A wrapper that runs a gate other than the one its filename names reports success for a program that
   * was never invoked, and four of them shipped. This is that class as a number counted over EVERY
   * `deploy/*-optional.sh`, not over the ones a phase happens to care about.
   */
  MISWIRED_OPTIONAL_WRAPPERS_MAX: 0,
  /**
   * NEW. A wait with no bound is not a slow failure, it is a hang — and a hang is worse than a failure,
   * because a failure is a verdict and a hang is a person deciding to give up. Counted over every compose-up
   * and every read step in the two provider gates.
   */
  UNBOUNDED_WAITS_MAX: 0,
  /**
   * NEW. An observation the gate writes as a literal is a number no run can move. Where it feeds a verdict it
   * manufactures a pass; where it feeds a SKIP it manufactures a skip that no repair can ever clear. Counted
   * over the observation record's decision-bearing fields.
   */
  LITERAL_OBSERVATION_FIELDS_MAX: 0,
  /**
   * NEW. "The host was left as it was found" is a statement about a SET, not about a count, and a cleanup
   * that removes a network it did not create satisfies the count while violating the sentence. This is the
   * number of pre-existing containers, networks and volumes a run may remove, and it is zero.
   */
  PREEXISTING_RESOURCES_REMOVED_MAX: 0,
  /**
   * NEW. A readiness record that contacts nothing may still leak everything. This is counted over the
   * recorder's emitted shape: a value, a URL, an object reference, an origin or an allowlist member appearing
   * in what it prints is one leak, and one is too many.
   */
  REDACTION_LEAKS_MAX: 0,
  /**
   * NEW. The failure mode of a readiness review is not that a finding is wrong; it is that a finding quietly
   * stops being mentioned. Every finding gets a disposition — repaired, superseded, out of scope with an
   * owner named, or refused — and this is the number that may have none.
   */
  FINDINGS_WITHOUT_A_DISPOSITION_MAX: 0,

  /**
   * IMPORTED from Phase 12. A repair nobody can regress is a repair somebody will undo, and every repair this
   * tranche makes carries a control that FAILS on the unrepaired bytes.
   */
  REPAIRS_WITHOUT_A_CONTROL_MAX: PHASE12_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX,
  /**
   * IMPORTED from Phase 12. Exit 77 is a SKIP, a skip is not a pass, and folding one into success is the
   * sentence this whole roadmap exists to stop being writable.
   */
  SKIPPED_CLAIMS_MAX: PHASE12_RULES.SKIPPED_CLAIMS_MAX,
} as const);

export type Phase13PreEntryRuleKey = keyof typeof PHASE13_PREENTRY_RULES;

// ---------------------------------------------------------------------------------------------------------
// §5 — the claims, in two tiers. Every one is answerable OFFLINE, from the shipped bytes or the fake path.
// ---------------------------------------------------------------------------------------------------------

/** §5.1 — the instrument repairs, each measurable against the bytes this tranche ships. */
export const PHASE13_PREENTRY_INSTRUMENT_GATE_IDS = Object.freeze([
  'P13PRE-I1-every-optional-wrapper-invokes-the-gate-it-names',
  'P13PRE-I2-the-provider-gate-real-mode-reads-the-operator-input-path',
  'P13PRE-I3-no-decision-bearing-observation-is-a-literal-a-run-cannot-move',
  'P13PRE-I4-every-compose-and-provider-wait-is-bounded',
  'P13PRE-I5-cleanup-removes-only-what-the-run-created',
  'P13PRE-I6-a-no-contact-readiness-record-emits-shape-only',
  'P13PRE-I7-staging-admits-a-guarded-pre-entry-directory-and-nothing-else',
  'P13PRE-I8-a-skip-is-never-folded-into-success',
  'P13PRE-I9-no-earlier-tranche-claim-is-written-or-half-written',
] as const);

/** §5.2 — the campaign that produced those repairs, and the state of the tree after it. */
export const PHASE13_PREENTRY_CAMPAIGN_GATE_IDS = Object.freeze([
  'P13PRE-C1-typecheck-and-offline-inventory-both-shells',
  'P13PRE-C2-every-repair-carries-a-control-that-fails-on-the-unrepaired-bytes',
  'P13PRE-C3-every-readiness-finding-carries-a-disposition',
] as const);

/** All twelve, in the document's order. */
export const PHASE13_PREENTRY_CLOSURE_GATE_IDS = Object.freeze([
  ...PHASE13_PREENTRY_INSTRUMENT_GATE_IDS,
  ...PHASE13_PREENTRY_CAMPAIGN_GATE_IDS,
] as const);

export type Phase13PreEntryGateId = (typeof PHASE13_PREENTRY_CLOSURE_GATE_IDS)[number];

export const PHASE13_PREENTRY_GATE_TITLES: Readonly<Record<Phase13PreEntryGateId, string>> = Object.freeze({
  'P13PRE-I1-every-optional-wrapper-invokes-the-gate-it-names':
    'every optional wrapper runs the gate its own filename names, and folds exit 77 alone',
  'P13PRE-I2-the-provider-gate-real-mode-reads-the-operator-input-path':
    'the real-provider gate in real mode reads the operator inputs rather than a fake-mode path',
  'P13PRE-I3-no-decision-bearing-observation-is-a-literal-a-run-cannot-move':
    'every observation a verdict or a skip is decided by is derived from evidence the run wrote',
  'P13PRE-I4-every-compose-and-provider-wait-is-bounded':
    'every compose wait and every read through the mount carries a bound and names its statuses',
  'P13PRE-I5-cleanup-removes-only-what-the-run-created':
    'cleanup removes no network, container or volume that existed before the run, and the sets are preserved',
  'P13PRE-I6-a-no-contact-readiness-record-emits-shape-only':
    'the readiness recorder contacts nothing and emits existence, type, mode, digest and shape only',
  'P13PRE-I7-staging-admits-a-guarded-pre-entry-directory-and-nothing-else':
    'staging admits one further marker, refuses every other basename, and the refusal boundary is unchanged',
  'P13PRE-I8-a-skip-is-never-folded-into-success':
    'a skip is refused by the closure function and 77 propagates from every entry point a claim may use',
  'P13PRE-I9-no-earlier-tranche-claim-is-written-or-half-written':
    'no P9, P10, P11 or P12 id is emittable here, and no claim of theirs is partially satisfied',
  'P13PRE-C1-typecheck-and-offline-inventory-both-shells':
    'the typecheck is clean and the full offline inventory passes from Git Bash and from PowerShell',
  'P13PRE-C2-every-repair-carries-a-control-that-fails-on-the-unrepaired-bytes':
    'each repair is re-run against a deliberately unrepaired copy and the check is asserted to fail',
  'P13PRE-C3-every-readiness-finding-carries-a-disposition':
    'every finding of the independent readiness review is repaired, superseded, or assigned with an owner',
});

/** Which threshold, if any, a claim is measured against. A claim with none has nothing to measure. */
export function phase13PreEntryBudgetKeyFor(gate: string): Phase13PreEntryRuleKey | undefined {
  switch (gate) {
    case 'P13PRE-I1-every-optional-wrapper-invokes-the-gate-it-names':
      return 'MISWIRED_OPTIONAL_WRAPPERS_MAX';
    case 'P13PRE-I3-no-decision-bearing-observation-is-a-literal-a-run-cannot-move':
      return 'LITERAL_OBSERVATION_FIELDS_MAX';
    case 'P13PRE-I4-every-compose-and-provider-wait-is-bounded':
      return 'UNBOUNDED_WAITS_MAX';
    case 'P13PRE-I5-cleanup-removes-only-what-the-run-created':
      return 'PREEXISTING_RESOURCES_REMOVED_MAX';
    case 'P13PRE-I6-a-no-contact-readiness-record-emits-shape-only':
      return 'REDACTION_LEAKS_MAX';
    case 'P13PRE-C2-every-repair-carries-a-control-that-fails-on-the-unrepaired-bytes':
      return 'REPAIRS_WITHOUT_A_CONTROL_MAX';
    case 'P13PRE-C3-every-readiness-finding-carries-a-disposition':
      return 'FINDINGS_WITHOUT_A_DISPOSITION_MAX';
    default:
      return undefined;
  }
}

export interface Phase13PreEntryGateResult {
  readonly gate: string;
  readonly verdict: 'pass' | 'fail' | 'skip';
  readonly measured?: number;
  readonly budget?: number;
}

export interface Phase13PreEntryResults {
  readonly results: readonly Phase13PreEntryGateResult[];
}

/**
 * The claims a run SKIPPED, as ids.
 *
 * A FUNCTION OVER THE RUN'S OWN VERDICTS rather than a constant, for Phase 10's reason: an audit found a
 * rehearsal that set a budget to zero and then asserted it was zero, with no line in the file able to move it.
 */
export function phase13PreEntrySkippedClaims(results: Phase13PreEntryResults): readonly string[] {
  return results.results.filter((one) => one.verdict === 'skip').map((one) => one.gate);
}

/**
 * The ids this tranche may NEVER emit a verdict for, in any direction.
 *
 * WHY IT IS A LIST RATHER THAN A SENTENCE. §12.1 of the Phase 12 document says Phase 13 may close "the
 * provider half only of `P11-R1`". There is no such half. `P11-R1` says a real provider-backed entry AND a
 * real Usenet-admitted file sit in ONE published generation; the property is co-residency, and one entitled
 * object alone in a generation demonstrates nothing about it. So the sentence is superseded rather than
 * implemented, and this list is what makes the supersession structural: the id cannot appear in a result set
 * this module will accept, so no amount of green can put a verdict beside it.
 */
export const PHASE13_PREENTRY_FORBIDDEN_EMITTABLE_IDS: readonly string[] = Object.freeze([
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
 * `P13-A` AND `P13-S` ARE ON IT ON PURPOSE. Those are the ids a real Phase 13 would use, and this tranche
 * enters no phase: a pre-entry record that could write one would be a pre-entry record that had entered.
 */
const FOREIGN_ID_PREFIXES: readonly string[] = Object.freeze([
  'P9-', 'P10-', 'P11-', 'P12-', 'P13-A', 'P13-S',
]);

/**
 * Everything wrong with a pre-entry run's evidence, as sentences.
 *
 * A LIST RATHER THAN A BOOLEAN: somebody assembling a record should learn everything that is missing in one
 * pass rather than one thing per attempt.
 */
export function phase13PreEntryClosureProblems(results: Phase13PreEntryResults): readonly string[] {
  const problems: string[] = [];

  const seen = new Map<string, Phase13PreEntryGateResult>();
  for (const result of results.results) {
    if (PHASE13_PREENTRY_FORBIDDEN_EMITTABLE_IDS.includes(result.gate)
      || FOREIGN_ID_PREFIXES.some((prefix) => result.gate.startsWith(prefix))) {
      problems.push(`the run reports a verdict for ${result.gate}, which belongs to another tranche; this `
        + 'one closes nothing of theirs, and in particular there is no provider half of P11-R1 to close');
      continue;
    }
    if (!(PHASE13_PREENTRY_CLOSURE_GATE_IDS as readonly string[]).includes(result.gate)) {
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

  // THE SKIP COUNT IS MEASURED BEFORE THE PER-CLAIM WALK, so a run that skipped four claims is told the
  // number as well as the four names.
  const skipped = phase13PreEntrySkippedClaims(results);
  if (skipped.length > PHASE13_PREENTRY_RULES.SKIPPED_CLAIMS_MAX) {
    problems.push(`${skipped.length} claim(s) were SKIPPED and §5.3 allows `
      + `${PHASE13_PREENTRY_RULES.SKIPPED_CLAIMS_MAX}; exit 77 is a skip, a skip is not a pass, and folding `
      + 'one is a decision that belongs in the command somebody typed rather than in a verdict');
  }

  for (const gateId of PHASE13_PREENTRY_CLOSURE_GATE_IDS) {
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
    const key = phase13PreEntryBudgetKeyFor(gateId);
    if (key === undefined) {
      if (result.measured !== undefined || result.budget !== undefined) {
        problems.push(`${gateId} reports a measurement against a budget §5.3 does not give it`);
      }
      continue;
    }
    const budget = PHASE13_PREENTRY_RULES[key];
    if (result.budget !== budget) {
      problems.push(`${gateId} was measured against ${String(result.budget)} rather than against the `
        + `contract's ${String(budget)}, so the verdict is against a budget this phase did not set`);
      continue;
    }
    if (typeof result.measured !== 'number') {
      problems.push(`${gateId} passed without recording what it measured`);
      continue;
    }
    // EVERY THRESHOLD HERE IS A CEILING OF ZERO. There is no floor, because there is no sequence: this
    // tranche runs no campaign against a host and counts no fresh runs.
    if (result.measured > budget) {
      problems.push(`${gateId} passed while reporting ${result.measured} against a budget of ${budget}`);
    }
  }

  return problems;
}

/** True only when nothing is wrong. The only place a boolean is derived from the list. */
export function phase13PreEntryClosed(results: Phase13PreEntryResults): boolean {
  return phase13PreEntryClosureProblems(results).length === 0;
}

// ---------------------------------------------------------------------------------------------------------
// §6 — the origin policy, for a pool that rotates faster than a sequence takes
// ---------------------------------------------------------------------------------------------------------

/**
 * How long an origin record may be trusted before it is stale.
 *
 * WHY THERE IS A NUMBER AT ALL. An operator's egress allowlist is checked against whichever CDN origin the
 * provider happens to be serving from at the moment of the check, and the measured pool rotates. An answer
 * taken two hours ago is not a weaker answer about now — it is an answer about a DIFFERENT origin, and
 * treating it as current is how a run starts against a pool member the allowlist does not name.
 */
export const ORIGIN_RECORD_MAX_AGE_MINUTES = 60;

/**
 * The margin between the measured lifetime of one origin and the bounded duration of a sequence.
 *
 * A SEQUENCE THAT EXACTLY FITS DOES NOT FIT. The measurement is of a pool observed over a window, not of a
 * contract the provider offers, so the shortest observed turn is a sample rather than a floor.
 */
export const ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES = 10;

export interface OriginStabilityPlan {
  /**
   * The SHORTEST turn observed for a member of the pool, in minutes. `undefined` means nobody measured it,
   * which is refused rather than assumed generous.
   */
  readonly shortestObservedOriginLifetimeMinutes?: number;
  /** The bounded duration this run has declared for itself, in minutes. An unbounded run has no answer. */
  readonly boundedSequenceDurationMinutes?: number;
  /** How old the origin record backing this plan is, in minutes. */
  readonly originRecordAgeMinutes?: number;
  /** How many distinct origins the allowlist admits. A pool larger than the allowlist rotates out of it. */
  readonly allowedOriginCount?: number;
  /** How many distinct origins the pool was observed to serve from. */
  readonly observedPoolSize?: number;
}

/**
 * Why a sequence may not start against a rotating pool, as sentences. Empty means it may.
 *
 * THE DISPOSITION THIS EXISTS FOR. A rotation mid-sequence has a specific signature — `stat` succeeds, the
 * listing is perfect, and every read fails EIO in well under a second — and without this it reads as a hard
 * FAIL about the product. It is not one. It is a fact about a CDN pool, and the honest answer is to refuse to
 * START a sequence whose bounded duration cannot fit inside one origin's measured turn, rather than to run it
 * and then argue about what the red meant. Widening the allowlist to make it green is a BLOCKER, not a step.
 */
export function originStabilityRefusals(plan: OriginStabilityPlan): readonly string[] {
  const refusals: string[] = [];

  const lifetime = plan.shortestObservedOriginLifetimeMinutes;
  const duration = plan.boundedSequenceDurationMinutes;
  const age = plan.originRecordAgeMinutes;

  const measured = typeof lifetime === 'number' && Number.isFinite(lifetime) && lifetime > 0;
  const bounded = typeof duration === 'number' && Number.isFinite(duration) && duration > 0;

  if (!measured) {
    refusals.push('the shortest origin lifetime was never measured, and an unmeasured lifetime is not a '
      + 'generous one; a pool nobody timed cannot be shown to cover any duration');
  }
  if (!bounded) {
    refusals.push('the sequence declares no bounded duration, so there is nothing for an origin turn to '
      + 'cover; an unbounded run cannot be fitted inside anything');
  }
  if (measured && bounded
    && (duration as number) > (lifetime as number) - ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES) {
    refusals.push(`the sequence is bounded at ${String(duration)} minutes and the shortest observed origin `
      + `turn is ${String(lifetime)} minutes, which does not cover it with the `
      + `${ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES}-minute margin; a rotation mid-sequence is then likely `
      + 'rather than hypothetical, and it would read as a failure of the product rather than as a fact '
      + 'about the pool');
  }

  if (typeof age !== 'number' || !Number.isFinite(age) || age < 0) {
    refusals.push('the origin record carries no age, so nothing says whether it is about the origin being '
      + 'served now or about a different one');
  } else if (age > ORIGIN_RECORD_MAX_AGE_MINUTES) {
    refusals.push(`the origin record is ${age} minutes old and ${ORIGIN_RECORD_MAX_AGE_MINUTES} is the most `
      + 'this policy trusts; a stale record is an answer about a different origin, not a weaker answer '
      + 'about this one');
  }

  const allowed = plan.allowedOriginCount;
  const pool = plan.observedPoolSize;
  if (typeof allowed === 'number' && typeof pool === 'number' && pool > allowed) {
    refusals.push(`the pool was observed serving from ${pool} origins and the allowlist admits ${allowed}, `
      + 'so some member of the pool is outside it and a rotation onto that member is certain given enough '
      + 'time. WIDENING THE ALLOWLIST IS A BLOCKER AND NOT A STEP: it is escalated as a count and a digest');
  }

  return refusals;
}

/** What a run does when the origin may have rotated out of the allowlist while it was running. */
export type OriginRotationDisposition = 'proceed' | 'abort-origin-rotated' | 'abort-not-measured';

/**
 * The disposition of a recheck, and it is NEVER a failure of the product.
 *
 * The three statuses are the recheck's own: 0 the serving origin is allowed, 70 it is not, anything else the
 * measurement could not be taken. Only the first proceeds; neither of the others is a FAIL, and neither is a
 * licence to widen anything.
 */
export function originRotationDisposition(recheckExitStatus: number): OriginRotationDisposition {
  if (recheckExitStatus === 0) return 'proceed';
  if (recheckExitStatus === 70) return 'abort-origin-rotated';
  return 'abort-not-measured';
}

// ---------------------------------------------------------------------------------------------------------
// §7 — the boundary
// ---------------------------------------------------------------------------------------------------------

/**
 * The sentence a pre-entry record may write, and the one it may not exceed.
 *
 * IT IS ABOUT AN INSTRUMENT. Not about a provider, not about a mount, not about an operator's account, and
 * not about the mixed product.
 */
export const PHASE13_PREENTRY_CEILING_SENTENCE =
  'the instrument was repaired; nothing was run against a provider, and no claim of any tranche moved';

/** What a pre-entry GO says, and no more. */
export const PHASE13_PREENTRY_MEANING =
  'the defects an independent readiness review found in the instrument a later Phase 13 would have to use '
  + 'are repaired, each with a control that fails on the unrepaired bytes. NO PROVIDER WAS CONTACTED, no '
  + 'credential was read, no allowlist was moved, no host state changed, and Phase 13 is NOT entered.';

/**
 * The states this tranche PRESERVES, restated so a report cannot quietly imply one moved.
 *
 * `test/projection-phase13-preentry.ts` asserts the phase document still says each of these in as many words.
 */
export const PHASE13_PREENTRY_PRESERVED_STATES = Object.freeze([
  'Phase 10 is GO and this tranche does not touch it',
  'Phase 11 tier one is GO and this tranche does not touch it',
  'Phase 12 is GO and this tranche does not touch it',
  'Phase 9 stays OPEN, and none of P9-2, P9-3, P9-5 or P9-11 is answered here',
  'Phase 11 tier two stays OPEN, and P11-R1 is NOT RUN and has no half to close',
  'Phase 13 is NOT ENTERED, and no live-provider claim is closed',
] as const);

/** The claims this tranche does NOT make. */
export const PHASE13_PREENTRY_NONCLAIMS = Object.freeze([
  'a real provider run',
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
 * The paths this tranche is forbidden to modify.
 *
 * IT IS PHASE 12's LIST PLUS PHASE 12's OWN MODULE. A tranche that could edit the rules it is measured
 * against is a tranche whose measurement concludes whatever it needs to.
 */
export const PHASE13_PREENTRY_FORBIDDEN_SOURCE: readonly string[] = Object.freeze([
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
]);

/**
 * THE PATHS THIS TRANCHE CREATES OR MODIFIES THAT DO NOT NAME A PROVIDER.
 *
 * WHY THIS LIST IS DELIBERATELY NOT THE WHOLE LIST, AND WHERE THE REST IS. Three of the scripts this tranche
 * repairs carry the provider's name in their FILENAME. All eight provider source allowlists under `test/`
 * walk `src/` and refuse any unlisted file that names the provider at all — and Phase 11 §6.2 records what
 * widening them costs, including that "five" was a conclusion drawn from an inventory run that had been
 * stopped part-way. `phase12.ts` avoided the whole question by not naming one, and so does this module: the
 * COMPLETE ownership list lives in the phase document's §11 table, which is the ownership record anyway, and
 * `test/projection-phase13-preentry.ts` parses that table, unions it with this list, and runs
 * `phase9RequiresSoakRerun` over the UNION. So the soak question is asked of everything, and no security
 * boundary moved for a filename.
 */
export const PHASE13_PREENTRY_TRANCHE_PATHS: readonly string[] = Object.freeze([
  'docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md',
  'src/core/projection/phase13-preentry.ts',
  'test/projection-phase13-preentry.ts',
  'test/projection-phase13-preentry-gate-audit.ts',
  'deploy/projection-preentry-readiness.sh',
  'deploy/projection-real-provider-gate.sh',
  'deploy/projection-real-provider-gate-optional.sh',
  'deploy/projection-path-lifecycle-gate-optional.sh',
  'deploy/projection-phase12-stage.sh',
  'test/projection-phase12.ts',
  'test/suite-inventory.json',
  'package.json',
]);

/**
 * The heading of the document section that carries the COMPLETE ownership list.
 *
 * Held as a constant so the suite cannot drift from the section it parses, and so a renamed section fails
 * loudly rather than quietly parsing nothing and reporting that nothing triggers a soak.
 */
export const PHASE13_PREENTRY_OWNERSHIP_SECTION = '## 11. File ownership — every path this tranche touches';
