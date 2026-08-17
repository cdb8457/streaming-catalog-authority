import { PHASE11_RULES } from './phase11.js';

// Projection Phase 12 — the tranche's rules, as code rather than as prose.
//
// WHAT PHASE 12 IS, IN ONE SENTENCE. Phase 11 shipped a mixed-source acceptance instrument whose own run
// record says the gate HAS NEVER REACHED A SINGLE ONE OF ITS SIX ARMS ON ANY HOST, and Phase 10 shipped a
// content plane whose own §11.7.4 says the rehearsal HAS NEVER RUN END TO END ON ANY HOST; Phase 12 attacks
// the first of those instruments independently and then tries to make both of those sentences false —
// provider-free, on the real host, without touching one thing an operator owns.
//
// WHAT THIS MODULE IS FOR. Three things a campaign gets wrong on its own.
//
// FIRST, A SKIP IS NOT A PASS AND EXIT 77 IS A SKIP. `SKIPPED_CLAIMS_MAX` is zero and `phase12SkippedClaims`
// is a FUNCTION over the run's own verdicts rather than a constant, because Phase 10's independent audit
// found a rehearsal that set a budget to zero and then asserted it was zero with no line able to move it.
//
// SECOND, A REPAIR NOBODY CAN REGRESS IS A REPAIR SOMEBODY WILL UNDO. `REPAIRS_WITHOUT_A_CONTROL_MAX` is
// zero, and it is the whole of §5.1's P12-A1: an audit that repaired nine things and pinned none of them has
// changed a tree rather than closed a class.
//
// THIRD, AN AUDITING TRANCHE IS EXACTLY WHERE A CONTRACT TERM MOVES BY ACCIDENT. `CONTRACT_TERMS_MOVED_MAX`
// is zero. Phase 11 §8's last paragraph says no threshold and no refusal may move except by a commit that
// changes that document first; the tranche most likely to move one is the one reading it closely enough to
// disagree with it.
//
// NOTHING HERE IMPORTS A GATE, TOUCHES A FILESYSTEM OR CONTACTS ANYTHING, and it names no provider — so no
// source allowlist has to be widened for it, which is the difference between this module and Phase 11's.

/**
 * The thresholds.
 *
 * FOUR ARE NEW AND EVERY OTHER ONE IS IMPORTED, read from the module of the tranche it came from. The four
 * new ones are the four things this tranche exists to establish and that no earlier tranche could have
 * measured, because no earlier tranche audited an instrument it did not build or staged a candidate onto the
 * host under a checked procedure.
 */
export const PHASE12_RULES = Object.freeze({
  /**
   * NEW. Phase 10 §11.7's own lesson as a number. A repair nobody can regress is a repair somebody will undo,
   * and this is what makes "each repair carries a control" checkable rather than promised.
   */
  REPAIRS_WITHOUT_A_CONTROL_MAX: 0,
  /**
   * NEW. Phase 11 §8's last paragraph as a number a run records: no threshold in that document's §5.3 and no
   * refusal in its §4 may move after its own commit. An auditing tranche is where they move by accident.
   */
  CONTRACT_TERMS_MOVED_MAX: 0,
  /**
   * NEW. A run on a tree that is not the candidate is a run whose figures belong to no commit. No earlier
   * tranche staged one onto the host under a procedure anything checked.
   */
  STAGED_FILES_DIFFERING_MAX: 0,
  /**
   * NEW. §4's fourth refusal as a number. Exit 77 is a SKIP, and a GO with a skip in it is the sentence this
   * whole roadmap exists to stop being writable.
   */
  SKIPPED_CLAIMS_MAX: 0,

  /** IMPORTED from Phase 11, which imported it from Phase 10, from Phase 9, from Phase 8, from Phase 3. */
  CONSECUTIVE_FRESH_RUNS: PHASE11_RULES.CONSECUTIVE_FRESH_RUNS,
  /** IMPORTED. Cleanup leaves zero phase-owned containers, networks and volumes. */
  RESIDUE_MAX: PHASE11_RULES.RESIDUE_MAX,
  /**
   * IMPORTED — the same number, named for the thing it is counted over. `RESIDUE_MAX` is what a gate asserts
   * about its own run; this is what the CAMPAIGN asserts about the operator's machine after all of them.
   */
  HOST_RESIDUE_MAX: PHASE11_RULES.RESIDUE_MAX,
} as const);

export type Phase12RuleKey = keyof typeof PHASE12_RULES;

// ---------------------------------------------------------------------------------------------------------
// §5 — the eleven claims, in three tiers
// ---------------------------------------------------------------------------------------------------------

/** §5.1 — what an independent read of Phase 11 found, and what was done about it. */
export const PHASE12_AUDIT_GATE_IDS = Object.freeze([
  'P12-A1-every-in-scope-defect-repaired-with-a-control',
  'P12-A2-every-defect-recorded-repaired-or-not',
  'P12-A3-no-phase-11-contract-term-moved',
] as const);

/** §5.2 — the runs that make "it has never run" false, and the state of the host after them. */
export const PHASE12_HOST_GATE_IDS = Object.freeze([
  'P12-P1-read-only-host-preflight-recorded',
  'P12-P2-candidate-staged-byte-identical-both-ways',
  'P12-R1-phase10-rehearsal-end-to-end-on-the-real-host',
  'P12-R2-phase11-mixed-gate-reached-all-six-arms-on-the-real-host',
  'P12-R3-both-three-run-wrappers-fresh-and-unskipped',
  'P12-R4-provider-free-regression-subset-green',
  'P12-C1-host-left-as-it-was-found',
] as const);

/** §5.3 — the candidate those figures came from. */
export const PHASE12_SEQUENCE_GATE_IDS = Object.freeze([
  'P12-S1-typecheck-and-offline-inventory-both-shells',
] as const);

/** All eleven, in the document's order. The ids are the contract's numbering, not a re-statement of it. */
export const PHASE12_CLOSURE_GATE_IDS = Object.freeze([
  ...PHASE12_AUDIT_GATE_IDS,
  ...PHASE12_HOST_GATE_IDS,
  ...PHASE12_SEQUENCE_GATE_IDS,
] as const);

export type Phase12GateId = (typeof PHASE12_CLOSURE_GATE_IDS)[number];

export const PHASE12_GATE_TITLES: Readonly<Record<Phase12GateId, string>> = Object.freeze({
  'P12-A1-every-in-scope-defect-repaired-with-a-control':
    'every in-scope defect the audit found is repaired, and each repair fails on the unrepaired bytes',
  'P12-A2-every-defect-recorded-repaired-or-not':
    'every defect the audit found is recorded, including the ones ruled out of scope',
  'P12-A3-no-phase-11-contract-term-moved':
    'no Phase 11 threshold, refusal, claim id or claim wording moved, and only its run record was edited',
  'P12-P1-read-only-host-preflight-recorded':
    'a read-only capability preflight of the real host is recorded before anything is created',
  'P12-P2-candidate-staged-byte-identical-both-ways':
    'one frozen candidate is staged and proved byte-identical against an archive of that commit, both ways',
  'P12-R1-phase10-rehearsal-end-to-end-on-the-real-host':
    'the Phase 10 rehearsal runs end to end on the real host, exit 0, zero skips',
  'P12-R2-phase11-mixed-gate-reached-all-six-arms-on-the-real-host':
    'the Phase 11 mixed gate reaches all six predeclared arms on the real host and exits 0',
  'P12-R3-both-three-run-wrappers-fresh-and-unskipped':
    'both three-run wrappers complete, exit 0, zero skips',
  'P12-R4-provider-free-regression-subset-green':
    'the provider-free regression subset is green from that one candidate',
  'P12-C1-host-left-as-it-was-found':
    'the container, network and volume sets are identical and no production container was altered',
  'P12-S1-typecheck-and-offline-inventory-both-shells':
    'the typecheck is clean and the full offline inventory passes from both shells, from that candidate',
});

/**
 * Which gate ids carry a measured number, and which threshold each is measured against.
 *
 * A gate id that returns `undefined` here is a PASS/FAIL claim with nothing to measure, and supplying a
 * measurement for one is a run that has invented a budget. §5.4's last paragraph, as a function.
 */
export function phase12BudgetKeyFor(gateId: string): Phase12RuleKey | undefined {
  switch (gateId) {
    case 'P12-A1-every-in-scope-defect-repaired-with-a-control':
      return 'REPAIRS_WITHOUT_A_CONTROL_MAX';
    case 'P12-A3-no-phase-11-contract-term-moved':
      return 'CONTRACT_TERMS_MOVED_MAX';
    case 'P12-P2-candidate-staged-byte-identical-both-ways':
      return 'STAGED_FILES_DIFFERING_MAX';
    case 'P12-R3-both-three-run-wrappers-fresh-and-unskipped':
      return 'CONSECUTIVE_FRESH_RUNS';
    case 'P12-C1-host-left-as-it-was-found':
      return 'HOST_RESIDUE_MAX';
    default:
      return undefined;
  }
}

/** The one threshold that is a FLOOR. Every other one is a ceiling of zero. */
const FLOOR_KEYS: readonly Phase12RuleKey[] = Object.freeze(['CONSECUTIVE_FRESH_RUNS']);

export interface Phase12GateResult {
  readonly gate: string;
  readonly verdict: 'pass' | 'fail' | 'skip';
  readonly measured?: number;
  readonly budget?: number;
}

export interface Phase12Results {
  /** One entry per fresh sequence, numbered from one. */
  readonly sequences: readonly { readonly index: number }[];
  readonly results: readonly Phase12GateResult[];
}

/**
 * The claims a run SKIPPED, as ids.
 *
 * WHY THIS IS A FUNCTION AND NOT A CONSTANT, AND IT IS THE LESSON OF PHASE 10's OWN INDEPENDENT AUDIT. That
 * audit's seventh defect was a rehearsal that set a budget to zero and then asserted it was zero: no line in
 * the file could move the variable. `SKIPPED_CLAIMS_MAX` is the number this campaign is likeliest to be
 * tempted by, because every gate in this repository can answer 77 and every wrapper can fold one.
 */
export function phase12SkippedClaims(results: Phase12Results): readonly string[] {
  return results.results.filter((one) => one.verdict === 'skip').map((one) => one.gate);
}

/**
 * Everything wrong with a run's evidence, as sentences.
 *
 * A LIST RATHER THAN A BOOLEAN, for the reason `phase11ClosureProblems` gives: somebody assembling a run
 * should learn everything that is missing in one pass rather than one thing per attempt.
 */
export function phase12ClosureProblems(results: Phase12Results): readonly string[] {
  const problems: string[] = [];

  const sequences = results.sequences.length;
  if (sequences !== PHASE12_RULES.CONSECUTIVE_FRESH_RUNS) {
    problems.push(`the run reports ${sequences} fresh sequences; §5 requires `
      + `${PHASE12_RULES.CONSECUTIVE_FRESH_RUNS}, and a shorter run closes nothing`);
  }
  for (let index = 0; index < results.sequences.length; index += 1) {
    if (results.sequences[index]?.index !== index + 1) {
      problems.push('the fresh sequences are not numbered from one without a gap, so at least one is missing '
        + 'or has been reported twice');
      break;
    }
  }

  const seen = new Map<string, Phase12GateResult>();
  for (const result of results.results) {
    if (!(PHASE12_CLOSURE_GATE_IDS as readonly string[]).includes(result.gate)) {
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
  // number as well as the four names. §5.4's `SKIPPED_CLAIMS_MAX` is zero and exit 77 is a skip.
  const skipped = phase12SkippedClaims(results);
  if (skipped.length > PHASE12_RULES.SKIPPED_CLAIMS_MAX) {
    problems.push(`${skipped.length} claim(s) were SKIPPED and §5.4 allows `
      + `${PHASE12_RULES.SKIPPED_CLAIMS_MAX}; exit 77 is a skip, a skip is not a pass, and folding one is a `
      + 'decision that belongs in the command somebody typed rather than in a verdict');
  }

  for (const gateId of PHASE12_CLOSURE_GATE_IDS) {
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
    const key = phase12BudgetKeyFor(gateId);
    if (key === undefined) {
      if (result.measured !== undefined || result.budget !== undefined) {
        problems.push(`${gateId} reports a measurement against a budget §5.4 does not give it`);
      }
      continue;
    }
    const budget = PHASE12_RULES[key];
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
export function phase12Closed(results: Phase12Results): boolean {
  return phase12ClosureProblems(results).length === 0;
}

/**
 * The sentence a Phase 12 GO may write, and the one it may not exceed.
 *
 * PHASE 11 §8 WROTE IT, NOT THIS TRANCHE, and Phase 11 took it from Phase 10 §8.1. It is held here as a
 * constant so that a summary which grew past it has to edit a module.
 */
export const PHASE12_CEILING_SENTENCE = 'what is missing is a run rather than a gate';

/** What a Phase 12 GO says, and no more. */
export const PHASE12_MEANING =
  'the instrument was attacked independently, its in-scope defects were repaired with controls, and the '
  + 'provider-free half of the path was observed running on the operator\'s own machine, three times, '
  + 'leaving nothing behind. It closes nothing about the mixed product.';

/**
 * The claims this tranche does NOT make, restated from §8 so a report cannot quietly imply one.
 *
 * `test/projection-phase12.ts` asserts that the phase document still says each of these.
 */
export const PHASE12_NONCLAIMS = Object.freeze([
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
 * The three phases §12 assigns the rest of the work to, and the one thing that is on none of them.
 *
 * WRITTEN AS DATA SO A SUITE CAN CHECK THE DOCUMENT STILL CONTAINS EACH, because the failure mode of a
 * roadmap is not that it is wrong — it is that a later tranche quietly stops mentioning the row it cannot
 * satisfy. `NOT_ON_THE_ROADMAP` is the other direction: a phase that needed it would be a phase that changed
 * the document first.
 */
export const PHASE12_ROADMAP_PHASES: readonly string[] = Object.freeze([
  '### 12.1 Phase 13',
  '### 12.2 Phase 14',
  '### 12.3 Phase 15',
]);

export const PHASE12_NOT_ON_THE_ROADMAP = 'Real-Debrid';

/**
 * The claims of earlier tranches Phase 12 may not close, re-label, re-word or partially satisfy.
 *
 * §4's fifth refusal. Phase 10 §8's prerequisite — that Phase 9's open claims be run from a Phase 10-or-later
 * candidate — is INHERITED by this tranche and discharged by none of it.
 */
export const PHASE12_UNTOUCHABLE_CLAIMS: readonly string[] = Object.freeze([
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
 * The paths this tranche is forbidden to modify, so §4's third, seventh and eighth refusals are checkable
 * rather than promised.
 *
 * `src/core/projection/phase11.ts` IS ON THIS LIST ON PURPOSE. Phase 11's rules are what Phase 12 audits the
 * gate AGAINST; a tranche that could edit both sides of that comparison is a tranche whose audit concludes
 * whatever it needs to.
 *
 * IT IS SOURCE ONLY, AND THE FORBIDDEN *DOCUMENTS* OF §6.3 ARE CHECKED BY `test/projection-phase12.ts`
 * AGAINST §6.3 ITSELF RATHER THAN LISTED HERE. One of them is a filename that names the provider, and the
 * eight provider source allowlists under `test/` scan every file under `src/` and refuse one that names it
 * and is not listed — so putting that filename in this module would mean widening eight provider boundaries
 * for a string. Phase 11 §6.2 had to widen them and recorded why; this tranche does not have to, and the
 * check still exists in the one place a filename can be compared against the document that forbids it.
 */
export const PHASE12_FORBIDDEN_SOURCE: readonly string[] = Object.freeze([
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
]);

/**
 * EVERY PATH THIS TRANCHE CREATES OR MODIFIES.
 *
 * WHAT IT IS FOR: `test/projection-phase12.ts` runs `phase9RequiresSoakRerun` over this list and asserts the
 * answer is FALSE. §3.1's first consequence — this tranche ships NO PRODUCT SOURCE — makes that easy, and the
 * list is what turns "easy" into "checked".
 *
 * WHAT IT IS NOT: a substitute for the OPERATOR SOURCE DIGEST, which `test/projection-bounded-recovery.ts`
 * recomputes on every run. This list is maintained by the people editing it, so on its own it could be wrong
 * in exactly the way that matters.
 */
export const PHASE12_TRANCHE_PATHS: readonly string[] = Object.freeze([
  'docs/PROJECTION_PHASE_12_AUDIT_AND_PROVIDER_FREE_CLOSURE.md',
  'src/core/projection/phase12.ts',
  'deploy/projection-phase12-stage.sh',
  'test/projection-phase12.ts',
  // THE PHASE 11 INSTRUMENT THE AUDIT REPAIRED, AND THE TWO SUITES THAT NOW REGRESS THOSE REPAIRS.
  'deploy/projection-phase11-mixed-gate.sh',
  'docker-compose.projection-phase11.yml',
  'test/projection-phase11.ts',
  'test/projection-phase11-gate-audit.ts',
  'docs/PROJECTION_PHASE_11_MIXED_SOURCE_ACCEPTANCE.md',
  // ONE LINE OF PHASE 10's COMPOSE FILE: the host interface its throwaway database publishes on. §6.2 records
  // the reason and `test/projection-phase12.ts` carries the control, because Phase 10's own suite is not
  // this tranche's to widen.
  'docker-compose.projection-phase10.yml',
  'docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md',
  // THE PHASE 10 REHEARSAL'S REGISTRY RESET AND ITS CONTROL. §6.2's amendment records why these two joined
  // the list after this contract's first commit: the first run that ever reached the real host found that
  // P10-3 seeds the shared throwaway database and P10-4 then counts as though the registry were empty.
  'deploy/projection-phase10-rehearsal.sh',
  'test/projection-phase10.ts',
  'test/suite-inventory.json',
  'package.json',
]);
