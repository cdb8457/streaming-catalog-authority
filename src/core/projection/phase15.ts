import { phase9RequiresSoakRerun } from './phase9.js';

// Projection Phase 15 — a pure release-evidence planner and closure predicate. It runs nothing.

export type Phase14Disposition = 'go' | 'preflight-issued' | 'missing';

export interface Phase15EntryState {
  readonly phase14Disposition: Phase14Disposition;
  readonly phase14OpenClaimsRecorded: boolean;
  readonly phase14WindowsRecorded: boolean;
  readonly earlierFrozenCandidatesRecorded: boolean;
}

export const PHASE15_CONTROL_SURFACES = Object.freeze({
  package: 'deploy/ci/release-candidate-acceptance.sh',
  install: 'deploy/projection-alpha.sh install',
  upgrade: 'deploy/projection-alpha.sh upgrade',
  rollback: 'deploy/projection-alpha.sh rollback',
  soakDecision: 'phase9RequiresSoakRerun(actualChangedPaths)',
  review: 'independent reader who did not build the tranche',
});

export const PHASE15_CLOSURE_CONDITIONS = Object.freeze([
  'frozen commit and immutable image digest recorded; build reproduced',
  'install, upgrade and rollback completed on the real host',
  'host sets preserved; namespace readable and bytes identical after rollback',
  'shipped runbook followed with zero outside commands and zero interventions',
  'soak ran if and only if the shared changed-path predicate requires it',
  'tier one and tier two each completed exactly three fresh runs with zero skips',
  'independent reviewer recorded findings and accepted the candidate',
] as const);

export function phase15EntryRefusals(state: Phase15EntryState): readonly string[] {
  const refusals: string[] = [];
  if (state.phase14Disposition === 'missing') refusals.push('E1 phase14Disposition: neither GO nor the required preflight exists');
  if (state.phase14Disposition === 'preflight-issued' && !state.phase14OpenClaimsRecorded) {
    refusals.push('E2 phase14OpenClaimsRecorded: a preflight entry must preserve every still-open claim');
  }
  if (state.phase14Disposition === 'preflight-issued' && !state.phase14WindowsRecorded) {
    refusals.push('E3 phase14WindowsRecorded: every open claim needs the window it is waiting for');
  }
  if (!state.earlierFrozenCandidatesRecorded) {
    refusals.push('E4 earlierFrozenCandidatesRecorded: every earlier real run record must name its candidate');
  }
  return Object.freeze(refusals);
}

export interface Phase15Plan {
  readonly report: 'projection-phase15-release-plan';
  readonly status: 'READY_TO_PREPARE' | 'BLOCKED';
  readonly phase15Run: false;
  readonly phase15Closed: false;
  readonly entryRefusals: readonly string[];
  readonly changedPathCount: number;
  readonly soakRequired: boolean;
  readonly controlSurfaces: typeof PHASE15_CONTROL_SURFACES;
  readonly closureConditions: typeof PHASE15_CLOSURE_CONDITIONS;
  readonly liveMaintenanceAuthorizationRequired: true;
}

export function buildPhase15Plan(state: Phase15EntryState, changedPaths: readonly string[]): Phase15Plan {
  const entryRefusals = phase15EntryRefusals(state);
  return Object.freeze({
    report: 'projection-phase15-release-plan',
    status: entryRefusals.length === 0 ? 'READY_TO_PREPARE' : 'BLOCKED',
    phase15Run: false,
    phase15Closed: false,
    entryRefusals,
    changedPathCount: changedPaths.length,
    soakRequired: phase9RequiresSoakRerun(changedPaths),
    controlSurfaces: PHASE15_CONTROL_SURFACES,
    closureConditions: PHASE15_CLOSURE_CONDITIONS,
    liveMaintenanceAuthorizationRequired: true,
  });
}

export interface Phase15Evidence {
  readonly frozenCommitRecorded: boolean;
  readonly immutableImageDigestRecorded: boolean;
  readonly reproducibleBuild: boolean;
  readonly installCompleted: boolean;
  readonly upgradeCompleted: boolean;
  readonly rollbackCompleted: boolean;
  readonly hostSetsPreserved: boolean;
  readonly namespaceReadableAfterRollback: boolean;
  readonly bytesIdenticalAfterRollback: boolean;
  readonly runbookFollowedLiterally: boolean;
  readonly commandsOutsideRunbook: number;
  readonly operatorInterventions: number;
  readonly soakRequired: boolean;
  readonly soakRan: boolean;
  readonly tierOneFreshRuns: number;
  readonly tierTwoFreshRuns: number;
  readonly skippedRuns: number;
  readonly independentReviewer: boolean;
  readonly reviewFindingsRecorded: boolean;
  readonly reviewDisposition: 'accept' | 'reject' | 'missing';
}

const wholeNonnegative = (value: number): boolean => Number.isFinite(value) && Number.isInteger(value) && value >= 0;

export function phase15ClosureProblems(
  entry: Phase15EntryState,
  evidence: Phase15Evidence,
  changedPaths: readonly string[],
): readonly string[] {
  const problems = [...phase15EntryRefusals(entry)];
  const required: Array<[keyof Phase15Evidence, string]> = [
    ['frozenCommitRecorded', 'C1 frozen commit is not recorded'],
    ['immutableImageDigestRecorded', 'C2 immutable image digest is not recorded'],
    ['reproducibleBuild', 'C3 bundle/image reproduction did not pass'],
    ['installCompleted', 'C4 install did not complete'],
    ['upgradeCompleted', 'C5 upgrade did not complete'],
    ['rollbackCompleted', 'C6 rollback did not complete'],
    ['hostSetsPreserved', 'C7 host container/network/volume membership was not preserved'],
    ['namespaceReadableAfterRollback', 'C8 namespace was not readable after rollback'],
    ['bytesIdenticalAfterRollback', 'C9 bytes after rollback did not match before upgrade'],
    ['runbookFollowedLiterally', 'C10 shipped runbook was not followed literally'],
    ['independentReviewer', 'C15 reviewer was not independent'],
    ['reviewFindingsRecorded', 'C16 review findings were not recorded'],
  ];
  for (const [field, problem] of required) if (evidence[field] !== true) problems.push(problem);
  for (const field of ['commandsOutsideRunbook', 'operatorInterventions', 'tierOneFreshRuns', 'tierTwoFreshRuns', 'skippedRuns'] as const) {
    if (!wholeNonnegative(evidence[field])) problems.push(`DOMAIN ${field}: expected a finite non-negative integer`);
  }
  if (wholeNonnegative(evidence.commandsOutsideRunbook) && evidence.commandsOutsideRunbook !== 0) problems.push('C11 commands ran outside the shipped runbook');
  if (wholeNonnegative(evidence.operatorInterventions) && evidence.operatorInterventions !== 0) problems.push('C12 operator interventions were required');
  const soakRequired = phase9RequiresSoakRerun(changedPaths);
  if (evidence.soakRequired !== soakRequired) problems.push('C13 recorded soak requirement does not match the deterministic changed-path predicate');
  if (evidence.soakRan !== soakRequired) problems.push('C13 soak execution does not match the deterministic changed-path predicate');
  if (wholeNonnegative(evidence.tierOneFreshRuns) && evidence.tierOneFreshRuns !== 3) problems.push('C14 tier one did not complete exactly three fresh runs');
  if (wholeNonnegative(evidence.tierTwoFreshRuns) && evidence.tierTwoFreshRuns !== 3) problems.push('C14 tier two did not complete exactly three fresh runs');
  if (wholeNonnegative(evidence.skippedRuns) && evidence.skippedRuns !== 0) problems.push('C14 a release sequence skipped');
  if (evidence.reviewDisposition !== 'accept') problems.push('C17 independent review did not ACCEPT');
  return Object.freeze(problems);
}

export function phase15Closed(entry: Phase15EntryState, evidence: Phase15Evidence, changedPaths: readonly string[]): boolean {
  return phase15ClosureProblems(entry, evidence, changedPaths).length === 0;
}
