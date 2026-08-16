import { PHASE7_SERVER_IDS } from './phase7.js';
import { PHASE8_RULES } from './phase8.js';
import { RELIABILITY_LOOP_RULES } from './reliability-loop.js';
import {
  SAB_CLIENT_BOUNDS,
  USENET_ADMISSION_BOUNDS,
  USENET_DEDICATED_CATEGORY,
  USENET_JOB_STATES,
  USENET_REFUSAL_REASONS,
} from '../usenet/sab-contract.js';

// Projection Phase 9 — the tranche's rules, as code rather than as prose.
//
// WHAT PHASE 9 IS, IN ONE SENTENCE. Phase 8 closed on an operator-usable alpha serving a TorBox-backed
// namespace through one mount to three real media servers; Phase 9 asks whether that same namespace can also
// hold files a Usenet worker produced — admitted only after download, repair, unpacking and byte verification
// have completed — WITHOUT the Usenet half being able to touch the TorBox half.
//
// THE SHAPE OF THE ANSWER, AND WHY IT IS THIS SHAPE. §2 refuses to put Usenet behind `source.Resolver`. That
// decision is what makes the rest of the tranche small: there is no new read path, no new daemon behaviour, no
// new manifest field and no new source kind. An admitted Usenet file is a `local` source, which the daemon has
// served since Phase 1, and the whole of Phase 9's new surface is the CONTROL PLANE deciding when a file has
// earned that status.
//
// WHAT THIS MODULE IS FOR. Two things, both of which a gate script gets wrong on its own. First, the closure
// rule is eleven numbered claims and a gate has to record a verdict for each; `phase9ClosureProblems` is what
// decides whether a run closed, driven rather than read. Second, every threshold Phase 9 measures against is
// IMPORTED from the closed tranche it comes from, so a number cannot be re-derived here and drift from the one
// the product is built on — the discipline Phase 7 applied to Phase 3 and Phase 8 applied to Phase 7.
//
// NOTHING HERE IMPORTS A GATE, TOUCHES A FILESYSTEM OR CONTACTS ANYTHING.

/** The three real media servers, and the ids are Phase 7's own so no report can disagree with another. */
export const PHASE9_SERVER_IDS = PHASE7_SERVER_IDS;

/** The operator-visible Usenet lifecycle, re-exported so a gate reads it from the phase it closes. */
export const PHASE9_JOB_STATES = USENET_JOB_STATES;

/**
 * The thresholds.
 *
 * TWO ARE NEW AND EVERY OTHER ONE IS IMPORTED. The new ones are the two things this tranche exists to
 * establish and that no earlier tranche could have measured: how many times one submission may reach the
 * worker, and how many admissions one completed job may produce. Both are one, both are the whole point, and
 * both are stated as thresholds rather than as prose so a gate can record a measured value against them.
 */
export const PHASE9_RULES = Object.freeze({
  /** NEW. One submission reaches the worker exactly once, across any number of restarts. §3, §5.6. */
  SUBMISSIONS_PER_SOURCE_MAX: 1,
  /** NEW. One completed job is admitted exactly once, across any number of reconciliations. §5.2. */
  ADMISSIONS_PER_JOB_MAX: 1,

  /** IMPORTED from Phase 8, which imported it from Phase 3. Three consecutive fresh runs close a tranche. */
  CONSECUTIVE_FRESH_RUNS: PHASE8_RULES.CONSECUTIVE_FRESH_SOAKS,
  /** IMPORTED. A run that needed a human between its parts has not run. */
  OPERATOR_INTERVENTIONS_MAX: PHASE8_RULES.OPERATOR_INTERVENTIONS_MAX,
  /** IMPORTED. A consumer restarted to make a run work is a run that did not work. */
  CONSUMER_RESTARTS_MAX: PHASE8_RULES.CONSUMER_RESTARTS_MAX,
  /** IMPORTED from Phase 3's reliability loop, through Phase 7 and Phase 8. */
  READY_BUDGET_MS: RELIABILITY_LOOP_RULES.READY_BUDGET_MS,

  /** IMPORTED from the worker boundary. Restated here only so a gate reads one table. */
  STABLE_DWELL_MS: USENET_ADMISSION_BOUNDS.STABLE_DWELL_MS,
  STABLE_SAMPLES: USENET_ADMISSION_BOUNDS.STABLE_SAMPLES,
  REQUEST_TIMEOUT_MS: SAB_CLIENT_BOUNDS.TIMEOUT_MS.default,

  /** §5.4: the mixed manifest carries at least one of each. */
  MIN_TORBOX_ENTRIES: 1,
  MIN_ADMITTED_USENET_ENTRIES: 1,
  /** §5.10: cleanup leaves zero phase-owned mounts, containers, networks and volumes. */
  RESIDUE_MAX: 0,
} as const);

export type Phase9RuleKey = keyof typeof PHASE9_RULES;

/**
 * The eleven claims of §5, in the contract's own order, as gate ids.
 *
 * THE IDS ARE THE CONTRACT'S NUMBERING AND NOT A RE-STATEMENT OF IT. A gate that invented its own ids would
 * be a gate whose evidence a reader has to map back onto the document by hand, and a mapping done by hand is a
 * mapping that stops being checked.
 */
export const PHASE9_CLOSURE_GATE_IDS = Object.freeze([
  'P9-1-offline-boundary-suite',
  'P9-2-real-job-admitted-once',
  'P9-3-failed-job-refused-and-absent',
  'P9-4-mixed-manifest',
  'P9-5-three-servers-scan-and-read-both',
  'P9-6-restart-no-duplicate-no-loss',
  'P9-7-usenet-outage-leaves-torbox-readable',
  'P9-8-existing-regression-gates-green',
  'P9-9-evidence-carries-no-identity',
  'P9-10-cleanup-leaves-nothing',
  'P9-11-three-consecutive-fresh-sequences',
] as const);

export type Phase9GateId = (typeof PHASE9_CLOSURE_GATE_IDS)[number];

/** What each claim is, in one line. Never a path, a URL, a name or an address. */
export const PHASE9_GATE_TITLES: Readonly<Record<Phase9GateId, string>> = Object.freeze({
  'P9-1-offline-boundary-suite':
    'every offline boundary, redaction, path-safety, idempotency and restart test passes',
  'P9-2-real-job-admitted-once':
    'a real Usenet job reaches completed and is admitted exactly once',
  'P9-3-failed-job-refused-and-absent':
    'one deliberately failed or incomplete job is refused and never appears in the manifest',
  'P9-4-mixed-manifest':
    'the mixed manifest contains at least one TorBox entry and one admitted Usenet entry',
  'P9-5-three-servers-scan-and-read-both':
    'Plex, Jellyfin and Emby each scan and read both entries through their existing pre-attached binds',
  'P9-6-restart-no-duplicate-no-loss':
    'a worker restart and a control-plane restart submit no duplicate job and lose no admitted entry',
  'P9-7-usenet-outage-leaves-torbox-readable':
    'a Usenet outage leaves the TorBox entry readable and the mounted namespace stable',
  'P9-8-existing-regression-gates-green':
    'projection restart, recovery, upgrade and rollback remain green on the existing focused gates',
  'P9-9-evidence-carries-no-identity':
    'secrets, NZB/indexer URLs, article ids and completed source paths appear in no preserved evidence',
  'P9-10-cleanup-leaves-nothing':
    'cleanup leaves zero phase-owned mounts, transient containers, networks and volumes',
  'P9-11-three-consecutive-fresh-sequences':
    'the complete mixed-provider sequence passes three consecutive fresh times',
});

/**
 * Which gate ids carry a measured number, and which threshold each is measured against.
 *
 * A gate id that returns `undefined` here is a PASS/FAIL claim with nothing to measure, and supplying a
 * measurement for one is a gate that has invented a budget.
 */
export function phase9BudgetKeyFor(gateId: string): Phase9RuleKey | undefined {
  switch (gateId) {
    case 'P9-2-real-job-admitted-once': return 'ADMISSIONS_PER_JOB_MAX';
    case 'P9-6-restart-no-duplicate-no-loss': return 'SUBMISSIONS_PER_SOURCE_MAX';
    case 'P9-10-cleanup-leaves-nothing': return 'RESIDUE_MAX';
    case 'P9-11-three-consecutive-fresh-sequences': return 'CONSECUTIVE_FRESH_RUNS';
    default: return undefined;
  }
}

/**
 * WHICH CLAIMS THE PROVIDER-FREE REHEARSAL CAN MAKE, AND WHICH IT CANNOT.
 *
 * THIS IS THE MOST IMPORTANT LIST IN THE FILE. A rehearsal that ran against a fake worker and reported the
 * same gate ids as a real run would be a rehearsal that closed the phase without a Usenet provider ever being
 * contacted — which is precisely the failure a phase document's closure rule exists to prevent. So the
 * rehearsal's own runner is required to emit ONLY these ids, and `phase9ClosureProblems` refuses a closure
 * whose evidence is entirely rehearsal evidence.
 *
 * §5.2 and §5.3 are absent because "a REAL Usenet job" is what they say. §5.5 is absent because three real
 * media servers reading through their pre-attached binds is not something a fake worker can stand in for.
 */
export const PHASE9_PROVIDER_FREE_GATE_IDS: readonly Phase9GateId[] = Object.freeze([
  'P9-1-offline-boundary-suite',
  'P9-4-mixed-manifest',
  'P9-6-restart-no-duplicate-no-loss',
  'P9-7-usenet-outage-leaves-torbox-readable',
  'P9-8-existing-regression-gates-green',
  'P9-9-evidence-carries-no-identity',
  'P9-10-cleanup-leaves-nothing',
]);

/** The four §5 claims that need a real Usenet provider and operator content, and nothing else does. */
export const PHASE9_PROVIDER_REQUIRED_GATE_IDS: readonly Phase9GateId[] = Object.freeze(
  PHASE9_CLOSURE_GATE_IDS.filter((id) => !PHASE9_PROVIDER_FREE_GATE_IDS.includes(id)),
);

/**
 * What an operator must supply before the provider-required half can run at all.
 *
 * IT IS A LIST OF INPUTS, NOT A LIST OF TASKS. Everything on it is something only the operator possesses, and
 * nothing on it is something this project could build, fake or infer. That distinction is what makes
 * "provider-free ready" an honest stopping point rather than an excuse.
 */
export const PHASE9_OPERATOR_INPUTS = Object.freeze([
  'a running SABnzbd the operator controls, reachable on loopback from the control plane',
  'that worker\'s API key, in a file whose mode grants nothing to group or other',
  'an NNTP provider already configured IN THE WORKER; this project never reads or holds one',
  `a dedicated category named ${USENET_DEDICATED_CATEGORY} with its own incomplete and complete directories`,
  'the complete directory placed under the media root the appliance already serves',
  'one NZB or indexer URL for content the operator is legally entitled to download',
  'one NZB the operator expects to FAIL or arrive incomplete, for the §5.3 refusal claim',
  'the existing TorBox real-provider corpus, so the mixed manifest has a TorBox entry',
] as const);

// ---------------------------------------------------------------------------------------------------------
// Closure
// ---------------------------------------------------------------------------------------------------------

export interface Phase9GateResult {
  readonly gate: string;
  readonly verdict: 'pass' | 'fail' | 'skip';
  readonly measured?: number;
  readonly budget?: number;
  /** True when this verdict came from the provider-free rehearsal rather than from a real run. */
  readonly rehearsal?: boolean;
}

export interface Phase9Results {
  /** One entry per fresh sequence, numbered from one. */
  readonly sequences: readonly { readonly index: number }[];
  readonly results: readonly Phase9GateResult[];
}

/**
 * Everything wrong with a run's evidence, as sentences.
 *
 * It is a LIST rather than a boolean for the same reason `real-provider.ts`'s is: somebody assembling a
 * multi-hour run against real media servers should learn everything that is missing in one pass.
 */
export function phase9ClosureProblems(results: Phase9Results): readonly string[] {
  const problems: string[] = [];

  const sequences = results.sequences.length;
  if (sequences !== PHASE9_RULES.CONSECUTIVE_FRESH_RUNS) {
    problems.push(`the run reports ${sequences} fresh sequences; §5.11 requires `
      + `${PHASE9_RULES.CONSECUTIVE_FRESH_RUNS}, and a shorter run closes nothing`);
  }
  for (let index = 0; index < results.sequences.length; index += 1) {
    if (results.sequences[index]?.index !== index + 1) {
      problems.push('the fresh sequences are not numbered from one without a gap, so at least one is missing '
        + 'or has been reported twice');
      break;
    }
  }

  const seen = new Map<string, Phase9GateResult>();
  for (const result of results.results) {
    if (!(PHASE9_CLOSURE_GATE_IDS as readonly string[]).includes(result.gate)) {
      problems.push(`the run reports a verdict for ${result.gate}, which §5 does not name`);
      continue;
    }
    const existing = seen.get(result.gate);
    if (existing !== undefined) {
      // A DUPLICATE VERDICT IS NOT A CONFIRMATION. Two verdicts for one claim means either the gate ran twice
      // and only one of them is being read, or two different things are answering to one id.
      problems.push(`${result.gate} carries more than one verdict, so it is not clear which one is the run's`);
      continue;
    }
    seen.set(result.gate, result);
  }

  for (const gateId of PHASE9_CLOSURE_GATE_IDS) {
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
    // A REHEARSAL VERDICT CANNOT CLOSE A PROVIDER-REQUIRED CLAIM. This is the check that keeps the honest
    // provider-free boundary honest.
    if (result.rehearsal === true && PHASE9_PROVIDER_REQUIRED_GATE_IDS.includes(gateId)) {
      problems.push(`${gateId} passed only in the provider-free rehearsal, and §5 asks it of a real Usenet job`);
    }
    const key = phase9BudgetKeyFor(gateId);
    if (key === undefined) {
      if (result.measured !== undefined || result.budget !== undefined) {
        problems.push(`${gateId} reports a measurement against a budget §4 does not give it`);
      }
      continue;
    }
    const budget = PHASE9_RULES[key];
    if (result.budget !== budget) {
      problems.push(`${gateId} was measured against ${String(result.budget)} rather than against the `
        + `contract's ${String(budget)}, so the verdict is against a budget this phase did not set`);
      continue;
    }
    if (typeof result.measured !== 'number') {
      problems.push(`${gateId} passed without recording what it measured`);
      continue;
    }
    // The two "exactly once" thresholds and the residue threshold are ceilings; the sequence count is a floor.
    const isFloor = key === 'CONSECUTIVE_FRESH_RUNS';
    if (isFloor ? result.measured < budget : result.measured > budget) {
      problems.push(`${gateId} passed while reporting ${result.measured} against a budget of ${budget}`);
    }
  }

  return problems;
}

/** True only when nothing is wrong. A convenience, and the only place a boolean is derived from the list. */
export function phase9Closed(results: Phase9Results): boolean {
  return phase9ClosureProblems(results).length === 0;
}

/**
 * The claims this tranche does NOT make, restated from §6 so a report cannot quietly imply one.
 *
 * `test/projection-phase9.ts` asserts that the phase document still says each of these, which is what stops a
 * summary from growing a claim the contract never authorised.
 */
export const PHASE9_NONCLAIMS = Object.freeze([
  'instant Usenet streaming',
  'automatic source failover',
  'indexer search',
  'download selection policy',
  'Real-Debrid',
  'a second host',
  'high availability',
  'a production release',
] as const);

/**
 * WHEN THE PHASE 8 SOAK HAS TO BE RE-RUN. §5's closing paragraph, encoded so the decision is not a judgement
 * call made at the end of a long week.
 *
 * The rule is not "did we touch the projection directory". It is whether SHARED projection mount, recovery,
 * cache or operator-command SOURCE moved — the four things the soak is a statement about. Adding a file under
 * `src/core/usenet/` moves none of them; editing `reliability-loop.ts` moves one.
 */
export const PHASE9_SOAK_TRIGGERING_SOURCE: readonly string[] = Object.freeze([
  'src/core/projection/reliability-loop.ts',
  'src/core/projection/runtime-contract.ts',
  'src/core/projection/path-lifecycle.ts',
  'src/core/projection/host-preflight.ts',
  'src/core/projection/daemon-read-geometry.ts',
  'src/core/projection/lease-gates.ts',
  'deploy/projection-alpha.sh',
  'docker-compose.projection-alpha.yml',
]);

export function phase9RequiresSoakRerun(changedPaths: readonly string[]): boolean {
  return changedPaths.some((path) => PHASE9_SOAK_TRIGGERING_SOURCE.includes(path.replace(/\\/g, '/')));
}

/** The closed set of refusal reasons, re-exported so a gate reads it from the phase module. */
export const PHASE9_REFUSAL_REASONS = USENET_REFUSAL_REASONS;
