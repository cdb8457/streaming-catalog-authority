import { PHASE9_RULES } from './phase9.js';
import { PROJECTION_DEGRADED_REASONS } from './manifest-v1.js';

// Projection Phase 10 — the tranche's rules, as code rather than as prose.
//
// WHAT PHASE 10 IS, IN ONE SENTENCE. Phase 9 built a control plane that can admit a Usenet file; Phase 10 asks
// whether an OPERATOR can get content into the namespace at all, whether the guard that protects the TorBox
// half of it actually runs on their appliance, and whether anything tells them when the namespace and the disk
// have stopped agreeing.
//
// WHAT THIS MODULE IS FOR. Three things a gate script gets wrong on its own.
//
// FIRST, the closure rule is ten numbered claims and a run has to record a verdict for each;
// `phase10ClosureProblems` is what decides whether a run closed, DRIVEN rather than read.
//
// SECOND, every threshold Phase 10 measures against is either IMPORTED from the closed tranche it came from
// or is NEW and named as new — the discipline Phase 7 applied to Phase 3, Phase 8 to Phase 7 and Phase 9 to
// Phase 8. A number that could be re-derived here is a number that drifts from the one the product is built
// on, silently, in the direction that makes the run pass.
//
// THIRD, the DIVERGENCE SET IS CLOSED. D10.4's whole design is a reconciliation that reports and does not act,
// and the fastest way for that to rot is for one more code to be added at the moment somebody needs one. A
// seventh code is a contract change, and `test/projection-phase10.ts` is what makes it one.
//
// NOTHING HERE IMPORTS A GATE, TOUCHES A FILESYSTEM OR CONTACTS ANYTHING.

/**
 * The thresholds.
 *
 * FOUR ARE NEW AND EVERY OTHER ONE IS IMPORTED. The new ones are the four things this tranche exists to
 * establish and that no earlier tranche could have measured: how many real admissions may skip the TorBox
 * drift check, how many things a REPORT may change, how many hand-run commands an operator path may need, and
 * how many bytes of the published generation a report may move. All four are ZERO, all four are the whole
 * point, and all four are stated as thresholds rather than as prose so a run can record a measured value
 * against them.
 */
export const PHASE10_RULES = Object.freeze({
  /**
   * NEW. §2.1 and P10-3. Today's shipped value is "every one of them": `createRegistryPublisher` returned
   * `{ publish }`, so `before` was null and every real admission was recorded `admittedWithoutDriftCheck`.
   */
  ADMISSIONS_WITHOUT_DRIFT_CHECK_MAX: 0,
  /** NEW. §4's second hard refusal, as a number a run can record. A `reconcile` that changed one thing failed. */
  AUTOMATIC_NAMESPACE_MUTATIONS_MAX: 0,
  /** NEW. P10-4. How many `tsx`/`npm run ops:` invocations the shipped operator path still needs. */
  HAND_RUN_COMMANDS_MAX: 0,
  /** NEW. P10-5, and §7 R5's mitigation: a report may not move one byte of the published generation. */
  GENERATION_BYTES_CHANGED_BY_REPORT_MAX: 0,

  /** IMPORTED from Phase 9, which imported it from Phase 8, which imported it from Phase 3. */
  CONSECUTIVE_FRESH_RUNS: PHASE9_RULES.CONSECUTIVE_FRESH_RUNS,
  /** IMPORTED. A run that needed a human between two of its parts has not run. */
  OPERATOR_INTERVENTIONS_MAX: PHASE9_RULES.OPERATOR_INTERVENTIONS_MAX,
  /** IMPORTED. Cleanup leaves zero phase-owned mounts, containers, networks and volumes. */
  RESIDUE_MAX: PHASE9_RULES.RESIDUE_MAX,
} as const);

export type Phase10RuleKey = keyof typeof PHASE10_RULES;

/** The compose port. Cross-checked against every other compose file by `test/projection-phase10.ts`. */
export const PHASE10_GATE_PG_PORT = 5670;

// ---------------------------------------------------------------------------------------------------------
// D10.4 — the closed divergence set
// ---------------------------------------------------------------------------------------------------------

/**
 * Everything `reconcile` may report, and it may report nothing else.
 *
 * CLOSED, AND THE ORDER IS THE CONTRACT'S. A code that exists in the reconciler and not here would be a
 * divergence with no documented meaning; a code here that nothing can produce would be worse, because a reader
 * would conclude the question had been asked.
 */
export const PHASE10_DIVERGENCE_CODES = Object.freeze([
  'registry-ahead-of-generation',
  'generation-pointer-disagrees',
  'local-source-file-absent',
  'local-source-bytes-changed',
  'entry-degraded',
  'ledger-entry-unregistered',
] as const);

export type Phase10DivergenceCode = (typeof PHASE10_DIVERGENCE_CODES)[number];

/** What each divergence MEANS to an operator, in one line. Never a path, a URL, an origin or an identity. */
export const PHASE10_DIVERGENCE_MEANINGS: Readonly<Record<Phase10DivergenceCode, string>> = Object.freeze({
  'registry-ahead-of-generation':
    'this entry is registered and is in no published generation, so no media server can see it yet; publish',
  'generation-pointer-disagrees':
    'the control plane, the pointer and the artifact do not agree about what is published; publish recovers it',
  'local-source-file-absent':
    'the file this entry names is not under the media root any more; nothing was changed on its own',
  'local-source-bytes-changed':
    'the file this entry names has a different size or mtime than the version registered for it',
  'entry-degraded':
    'this entry is degraded and stays in the namespace with its inode, size and mtime untouched',
  'ledger-entry-unregistered':
    'the Usenet ledger records this as admitted and the registry has no entry for it',
});

/**
 * The two verbs an operator may act with, and the degraded reason each uses.
 *
 * `operator-hold` IS ALREADY IN `PROJECTION_DEGRADED_REASONS`. Phase 10 §4's first hard refusal is that this
 * tranche adds no reason, no field and no schema version, and this constant is where that is checkable rather
 * than asserted: if the reason ever left the closed set, this module would not load.
 */
export const PHASE10_HOLD_REASON = ((): 'operator-hold' => {
  if (!(PROJECTION_DEGRADED_REASONS as readonly string[]).includes('operator-hold')) {
    throw new Error('PHASE10_HOLD_REASON_NOT_IN_CLOSED_SET: Phase 10 adds no degraded reason, and the one it '
      + 'uses has left the contract\'s closed set');
  }
  return 'operator-hold';
})();

// ---------------------------------------------------------------------------------------------------------
// §5 — the ten claims
// ---------------------------------------------------------------------------------------------------------

/**
 * The ten claims of §5, in the contract's own order, as gate ids.
 *
 * THE IDS ARE THE CONTRACT'S NUMBERING AND NOT A RE-STATEMENT OF IT. A gate that invented its own ids would be
 * a gate whose evidence a reader has to map back onto the document by hand, and a mapping done by hand is a
 * mapping that stops being checked.
 */
export const PHASE10_CLOSURE_GATE_IDS = Object.freeze([
  'P10-1-offline-inventory-both-shells',
  'P10-2-rehearsal-three-fresh',
  'P10-3-drift-guard-runs-on-real-admission',
  'P10-4-operator-path-shipped-verbs-only',
  'P10-5-absent-local-source-reported-not-repaired',
  'P10-6-operator-digest-unmoved-no-soak-rerun',
  'P10-7-provider-free-regression-subset-green',
  'P10-8-cleanup-leaves-nothing',
  'P10-9-evidence-carries-no-identity',
  'P10-10-three-consecutive-fresh-sequences',
] as const);

export type Phase10GateId = (typeof PHASE10_CLOSURE_GATE_IDS)[number];

export const PHASE10_GATE_TITLES: Readonly<Record<Phase10GateId, string>> = Object.freeze({
  'P10-1-offline-inventory-both-shells':
    'the full offline inventory passes with every Phase 10 suite in it, from Git Bash and from PowerShell',
  'P10-2-rehearsal-three-fresh':
    'three consecutive fresh rehearsal runs on the real host, exit 0, zero skips',
  'P10-3-drift-guard-runs-on-real-admission':
    'a real admission records no admittedWithoutDriftCheck, and a forged move is refused permanently',
  'P10-4-operator-path-shipped-verbs-only':
    'an operator reaches a readable namespace using only shipped verbs, with no hand-run command',
  'P10-5-absent-local-source-reported-not-repaired':
    'a removed local source is reported, the generation is byte-identical, and hold then release work',
  'P10-6-operator-digest-unmoved-no-soak-rerun':
    'the operator source digest is unmoved and this tranche does not re-open the Phase 8 soak',
  'P10-7-provider-free-regression-subset-green':
    'the provider-free regression subset is green from one frozen candidate',
  'P10-8-cleanup-leaves-nothing':
    'cleanup leaves zero phase-owned mounts, transient containers, networks and volumes',
  'P10-9-evidence-carries-no-identity':
    'no preserved evidence carries a secret, a URL, an origin, a path or a media identity',
  'P10-10-three-consecutive-fresh-sequences':
    'the complete sequence passes three consecutive fresh times',
});

/**
 * Which gate ids carry a measured number, and which threshold each is measured against.
 *
 * A gate id that returns `undefined` here is a PASS/FAIL claim with nothing to measure, and supplying a
 * measurement for one is a run that has invented a budget.
 */
export function phase10BudgetKeyFor(gateId: string): Phase10RuleKey | undefined {
  switch (gateId) {
    case 'P10-3-drift-guard-runs-on-real-admission': return 'ADMISSIONS_WITHOUT_DRIFT_CHECK_MAX';
    case 'P10-4-operator-path-shipped-verbs-only': return 'HAND_RUN_COMMANDS_MAX';
    case 'P10-5-absent-local-source-reported-not-repaired': return 'GENERATION_BYTES_CHANGED_BY_REPORT_MAX';
    case 'P10-8-cleanup-leaves-nothing': return 'RESIDUE_MAX';
    case 'P10-10-three-consecutive-fresh-sequences': return 'CONSECUTIVE_FRESH_RUNS';
    default: return undefined;
  }
}

/**
 * WHICH CLAIMS THE PROVIDER-FREE REHEARSAL CAN MAKE.
 *
 * ALL TEN, AND THAT IS THE DESIGN RATHER THAN AN ACCIDENT. §1: provider windows are this project's scarcest
 * resource, and a tranche that can close without one is a tranche that closes. This list exists anyway, in the
 * same shape as `PHASE9_PROVIDER_FREE_GATE_IDS`, so that the day somebody proposes a Phase 10 claim needing a
 * provider they have to edit a list rather than quietly widen a run.
 */
export const PHASE10_PROVIDER_FREE_GATE_IDS: readonly Phase10GateId[] = Object.freeze([...PHASE10_CLOSURE_GATE_IDS]);

export const PHASE10_PROVIDER_REQUIRED_GATE_IDS: readonly Phase10GateId[] = Object.freeze([]);

/**
 * THE CLAIMS ONE REHEARSAL RUN MAY NOT ANSWER, AND THIS IS THE MOST IMPORTANT LIST IN THE FILE.
 *
 * Phase 9's equivalent refusal was about a PROVIDER: a rehearsal against a fake worker could not close a claim
 * that says "a real Usenet job". Phase 10 has no provider, so the same failure wears a different shape — a
 * rehearsal that emitted all ten ids would close the tranche from ONE run on ONE shell, and four of the ten
 * are claims about a SET of runs that the rehearsal is not one of:
 *
 *   P10-1  the full offline inventory, from BOTH shells — a rehearsal runs the suites it names, on the shell
 *          it was launched from, and the second shell is a separate launch it cannot perform;
 *   P10-2  three consecutive FRESH rehearsal runs on the real host — one run is not three, and the wrapper
 *          that counts them is the only thing that can say so;
 *   P10-7  the provider-free regression subset from one frozen candidate — eleven other gates, none of them
 *          this one;
 *   P10-10 three consecutive fresh SEQUENCES — the same argument as P10-2, one level up.
 *
 * `phase10ClosureProblems` refuses a `rehearsal: true` verdict for any of them, which is what keeps a green
 * rehearsal from reading as a closure.
 */
export const PHASE10_SEQUENCE_LEVEL_GATE_IDS: readonly Phase10GateId[] = Object.freeze([
  'P10-1-offline-inventory-both-shells',
  'P10-2-rehearsal-three-fresh',
  'P10-7-provider-free-regression-subset-green',
  'P10-10-three-consecutive-fresh-sequences',
]);

/** The complement: what one rehearsal run may legitimately answer. A partition of the ten, by construction. */
export const PHASE10_REHEARSAL_EMITTABLE_GATE_IDS: readonly Phase10GateId[] = Object.freeze(
  PHASE10_CLOSURE_GATE_IDS.filter((id) => !PHASE10_SEQUENCE_LEVEL_GATE_IDS.includes(id)),
);

/**
 * The claims whose evidence depends on ANOTHER DISPATCH landing first.
 *
 * §2.6: the seven POSIX-shell suites belong to `task_49ab24180bd0`. Phase 10 does not edit them and does not
 * re-do the work; it asserts the result. Until that commit is in the same tree, P10-1's second arm — the
 * ordinary-PowerShell run — is NOT RUN, and a NOT RUN is not a pass. `phase10ClosureProblems` says so.
 */
export const PHASE10_INTEGRATION_DEPENDENT_GATE_IDS: readonly Phase10GateId[] = Object.freeze([
  'P10-1-offline-inventory-both-shells',
]);

// ---------------------------------------------------------------------------------------------------------
// Closure
// ---------------------------------------------------------------------------------------------------------

export interface Phase10GateResult {
  readonly gate: string;
  readonly verdict: 'pass' | 'fail' | 'skip';
  readonly measured?: number;
  readonly budget?: number;
  /** True when this verdict came from the provider-free rehearsal rather than from the full sequence. */
  readonly rehearsal?: boolean;
}

export interface Phase10Results {
  /** One entry per fresh sequence, numbered from one. */
  readonly sequences: readonly { readonly index: number }[];
  readonly results: readonly Phase10GateResult[];
}

/**
 * Everything wrong with a run's evidence, as sentences.
 *
 * A LIST RATHER THAN A BOOLEAN, for the reason `phase9ClosureProblems` gives: somebody assembling a run should
 * learn everything that is missing in one pass rather than one thing per attempt.
 */
export function phase10ClosureProblems(results: Phase10Results): readonly string[] {
  const problems: string[] = [];

  const sequences = results.sequences.length;
  if (sequences !== PHASE10_RULES.CONSECUTIVE_FRESH_RUNS) {
    problems.push(`the run reports ${sequences} fresh sequences; §5 requires `
      + `${PHASE10_RULES.CONSECUTIVE_FRESH_RUNS}, and a shorter run closes nothing`);
  }
  for (let index = 0; index < results.sequences.length; index += 1) {
    if (results.sequences[index]?.index !== index + 1) {
      problems.push('the fresh sequences are not numbered from one without a gap, so at least one is missing '
        + 'or has been reported twice');
      break;
    }
  }

  const seen = new Map<string, Phase10GateResult>();
  for (const result of results.results) {
    if (!(PHASE10_CLOSURE_GATE_IDS as readonly string[]).includes(result.gate)) {
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

  for (const gateId of PHASE10_CLOSURE_GATE_IDS) {
    const result = seen.get(gateId);
    if (result === undefined) {
      problems.push(`§5 claim ${gateId} has no verdict, and an absent verdict is not a pass`);
      continue;
    }
    if (result.verdict === 'skip') {
      // §7 R6. This is the line that stops the integration dependency from being quietly folded in: the
      // shell-portability work landing late means P10-1 is NOT RUN, and NOT RUN blocks the GO rather than
      // being averaged away.
      problems.push(`${gateId} was skipped or is NOT RUN; a skip proves nothing and is never folded into a pass`
        + (PHASE10_INTEGRATION_DEPENDENT_GATE_IDS.includes(gateId)
          ? ' — this claim depends on the POSIX-shell harness repair landing in the same tree' : ''));
      continue;
    }
    if (result.verdict !== 'pass') {
      problems.push(`${gateId} did not pass`);
      continue;
    }
    // A REHEARSAL VERDICT CANNOT CLOSE A CLAIM ABOUT A SET OF RUNS. This is the check that keeps a green
    // rehearsal from reading as a closure; see PHASE10_SEQUENCE_LEVEL_GATE_IDS for why these four and no
    // others.
    if (result.rehearsal === true && PHASE10_SEQUENCE_LEVEL_GATE_IDS.includes(gateId)) {
      problems.push(`${gateId} passed only in one rehearsal run, and §5 asks it of a set of runs this one is `
        + 'not a member of');
    }
    const key = phase10BudgetKeyFor(gateId);
    if (key === undefined) {
      if (result.measured !== undefined || result.budget !== undefined) {
        problems.push(`${gateId} reports a measurement against a budget §5.1 does not give it`);
      }
      continue;
    }
    const budget = PHASE10_RULES[key];
    if (result.budget !== budget) {
      problems.push(`${gateId} was measured against ${String(result.budget)} rather than against the `
        + `contract's ${String(budget)}, so the verdict is against a budget this phase did not set`);
      continue;
    }
    if (typeof result.measured !== 'number') {
      problems.push(`${gateId} passed without recording what it measured`);
      continue;
    }
    // Every new threshold is a CEILING of zero; the sequence count is a FLOOR.
    const isFloor = key === 'CONSECUTIVE_FRESH_RUNS';
    if (isFloor ? result.measured < budget : result.measured > budget) {
      problems.push(`${gateId} passed while reporting ${result.measured} against a budget of ${budget}`);
    }
  }

  return problems;
}

/** True only when nothing is wrong. The only place a boolean is derived from the list. */
export function phase10Closed(results: Phase10Results): boolean {
  return phase10ClosureProblems(results).length === 0;
}

/**
 * The claims this tranche does NOT make, restated from §9 so a report cannot quietly imply one.
 *
 * `test/projection-phase10.ts` asserts that the phase document still says each of these, which is what stops a
 * summary from growing a claim the contract never authorised.
 */
export const PHASE10_NONCLAIMS = Object.freeze([
  'a soak',
  'a load test',
  'an uptime claim',
  'a second host',
  'high availability',
  'a production release',
  'Real-Debrid',
  'instant Usenet streaming',
  'automatic source failover',
] as const);

/**
 * WHAT PHASE 10 SAYS ABOUT PHASE 9, AND THE ONE THING IT MAY NOT DO.
 *
 * §8. Phase 10 §2.1 changes what a Phase 9 live run would MEAN: running P9-2, P9-3, P9-5 or P9-11 against a
 * pre-Phase-10 candidate would close Phase 9 on an appliance whose sixth hard refusal never once executed on a
 * real admission. That is a statement about the CANDIDATE, not about the claims — so this module records a
 * prerequisite and provides no way whatsoever to record a `P9-` verdict.
 */
export const PHASE10_PHASE9_PREREQUISITE =
  'Phase 9\'s four open live claims must be run from a Phase 10-or-later candidate, because the TorBox drift '
  + 'guard did not run on a single real admission before D10.1';

/** The four Phase 9 claims Phase 10 may not close, re-label, re-word or partially satisfy. §4's seventh refusal. */
export const PHASE10_UNTOUCHABLE_PHASE9_CLAIMS: readonly string[] = Object.freeze([
  'P9-2-real-job-admitted-once',
  'P9-3-failed-job-refused-and-absent',
  'P9-5-three-servers-scan-and-read-both',
  'P9-11-three-consecutive-fresh-sequences',
]);

/**
 * The paths this tranche is forbidden to modify, so §4's fifth and sixth refusals are checkable rather than
 * promised. `test/projection-phase10.ts` runs `phase9RequiresSoakRerun` over the tranche's own changed-path
 * set; this list is the wider one, covering what the OPERATOR SOURCE DIGEST also covers.
 */
export const PHASE10_FORBIDDEN_SOURCE: readonly string[] = Object.freeze([
  'deploy/projection-alpha.sh',
  'deploy/projectiond-alpha.env.example',
  'docker-compose.projection-alpha.yml',
  'docs/PROJECTION_PHASE_9_TORBOX_USENET.md',
  'src/core/projection/phase7.ts',
  'src/core/projection/phase8.ts',
  'src/core/projection/phase9.ts',
]);

/**
 * EVERY PATH THIS TRANCHE CREATES OR MODIFIES.
 *
 * WHAT IT IS FOR: `test/projection-phase10.ts` runs `phase9RequiresSoakRerun` over this list and asserts the
 * answer is FALSE, which is §5's P10-6 driven rather than promised. The contract's own decision procedure is
 * called; a suite that re-implemented the rule would be a suite that could disagree with the product about
 * whether a six-hour soak has to be re-run.
 *
 * WHAT IT IS NOT: a substitute for the OPERATOR SOURCE DIGEST. This list is maintained by the people editing
 * it, so on its own it could be wrong in exactly the way that matters. `test/projection-bounded-recovery.ts`
 * recomputes the digest over `deploy/projection-alpha.sh`, its two helper programs, the env-contract example
 * and `docker-compose.projection-alpha.yml` on EVERY run and compares it against the documented value — that
 * is the guard that cannot be forgotten, and this list is the statement of intent beside it.
 */
export const PHASE10_TRANCHE_PATHS: readonly string[] = Object.freeze([
  'docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md',
  'docs/PROJECTION_CONTENT_OPERATOR_RUNBOOK.md',
  'docs/PROJECTION_PHASE_9_USENET_RUNBOOK.md',
  'src/core/projection/phase10.ts',
  'src/core/projection/namespace-snapshot.ts',
  'src/core/projection/publish-service.ts',
  'src/core/projection/publisher.ts',
  'src/core/usenet/admission.ts',
  'src/ops/projection-content.ts',
  'src/ops/projection-content-cli.ts',
  'src/ops/usenet-command.ts',
  'deploy/projection-content.sh',
  'deploy/projection-phase10-rehearsal.sh',
  'deploy/projection-phase10-rehearsal-three.sh',
  'deploy/projection-phase10-rehearsal-optional.sh',
  'docker-compose.projection-phase10.yml',
  'test/projection-phase10.ts',
  'test/projection-phase10-gate-audit.ts',
  'test/projection-content-command.ts',
  'test/projection-content-db.ts',
  'test/projection-namespace-snapshot.ts',
  'test/projection-drift-guard-db.ts',
  'test/usenet-admission.ts',
  'test/suite-inventory.json',
  'package.json',
  // THE EIGHT TORBOX SOURCE ALLOWLISTS. §6.2: a new file that names TorBox joins them WITH ITS REASON WRITTEN
  // BESIDE IT, which the allowlist's own comment says is the only legitimate way to widen one. They are on
  // this list because they were edited, and a path list that omitted the edits nobody wanted to admit to
  // would be the one place a stale declaration does real harm.
  'test/torbox-boundary.ts',
  'test/torbox-fake-adapter.ts',
  'test/torbox-live-smoke-cli.ts',
  'test/torbox-live-transport.ts',
  'test/torbox-provider-adapter.ts',
  'test/torbox-readonly-client.ts',
  'test/torbox-real-client-gate.ts',
  'test/torbox-transport-acceptance.ts',
]);

/**
 * The seven suites Phase 10 must NOT edit, because dispatch `task_49ab24180bd0` owns them.
 *
 * §2.6 and §6.3. Named in code rather than only in prose so a suite can assert the boundary held, which is
 * what stops two dispatches from silently editing the same seven files.
 */
export const PHASE10_FOREIGN_DISPATCH_SUITES: readonly string[] = Object.freeze([
  'test/projection-emby-dataplane.ts',
  'test/projection-jellyfin-dataplane.ts',
  'test/projection-path-lifecycle.ts',
  'test/projection-plex-dataplane.ts',
  'test/projection-rclone-comparison.ts',
  'test/projection-real-provider.ts',
  'test/projection-three-server-concurrency.ts',
]);
