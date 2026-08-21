import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  PHASE15_CONTROL_SURFACES,
  PHASE15_CLOSURE_CONDITIONS,
  buildPhase15Plan,
  phase15Closed,
  phase15ClosureProblems,
  phase15EntryRefusals,
  type Phase15EntryState,
  type Phase15Evidence,
} from '../src/core/projection/phase15.js';

const h = createHarness('Projection Phase 15 — release and rollback control plane');
const { test } = h;
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const entry: Phase15EntryState = {
  phase14Disposition: 'preflight-issued',
  phase14OpenClaimsRecorded: true,
  phase14WindowsRecorded: true,
  earlierFrozenCandidatesRecorded: true,
};
const green: Phase15Evidence = {
  frozenCommitRecorded: true, immutableImageDigestRecorded: true, reproducibleBuild: true,
  installCompleted: true, upgradeCompleted: true, rollbackCompleted: true, hostSetsPreserved: true,
  namespaceReadableAfterRollback: true, bytesIdenticalAfterRollback: true, runbookFollowedLiterally: true,
  commandsOutsideRunbook: 0, operatorInterventions: 0, soakRequired: false, soakRan: false,
  tierOneFreshRuns: 3, tierTwoFreshRuns: 3, skippedRuns: 0, independentReviewer: true,
  reviewFindingsRecorded: true, reviewDisposition: 'accept',
};

h.section('entry and deterministic planning');

test('a Phase 14 preflight can enter preparation only with open claims and windows recorded', () => {
  assertEq(phase15EntryRefusals(entry).length, 0, 'honest preflight entry');
  for (const field of ['phase14OpenClaimsRecorded', 'phase14WindowsRecorded', 'earlierFrozenCandidatesRecorded'] as const) {
    const state = { ...entry, [field]: false };
    assert(phase15EntryRefusals(state).some((r) => r.includes(field)), `${field} did not block`);
  }
  assert(phase15EntryRefusals({ ...entry, phase14Disposition: 'missing' }).some((r) => r.includes('phase14Disposition')), 'missing Phase 14 did not block');
});

test('planner runs nothing, reports the exact existing controls, and asks the shared soak predicate', () => {
  const ordinary = buildPhase15Plan(entry, ['src/core/projection/phase14.ts']);
  assertEq(ordinary.status, 'READY_TO_PREPARE', 'ordinary plan');
  assertEq(ordinary.soakRequired, false, 'non-triggering path requested soak');
  assertEq(ordinary.phase15Run, false, 'planner claims a run');
  assertEq(ordinary.phase15Closed, false, 'planner claims closure');
  const triggering = buildPhase15Plan(entry, ['deploy/projection-alpha.sh']);
  assertEq(triggering.soakRequired, true, 'operator source did not request soak');
  assertEq(PHASE15_CONTROL_SURFACES.install, 'deploy/projection-alpha.sh install', 'installer duplicated');
  assertEq(PHASE15_CONTROL_SURFACES.rollback, 'deploy/projection-alpha.sh rollback', 'rollback duplicated');
  assertEq(ordinary.closureConditions, PHASE15_CLOSURE_CONDITIONS, 'closure conditions drifted');
});

h.section('closure is non-vacuous and fail-closed');

test('one complete accepted record closes and every boolean evidence field independently bites', () => {
  assertEq(phase15ClosureProblems(entry, green, []).length, 0, 'green record problems');
  assertEq(phase15Closed(entry, green, []), true, 'green record does not close');
  for (const field of [
    'frozenCommitRecorded', 'immutableImageDigestRecorded', 'reproducibleBuild', 'installCompleted',
    'upgradeCompleted', 'rollbackCompleted', 'hostSetsPreserved', 'namespaceReadableAfterRollback',
    'bytesIdenticalAfterRollback', 'runbookFollowedLiterally', 'independentReviewer', 'reviewFindingsRecorded',
  ] as const) {
    assert(phase15ClosureProblems(entry, { ...green, [field]: false }, []).length > 0, `${field} did not bite`);
  }
});

test('numeric evidence rejects NaN, infinities, negatives and fractional counts before comparison', () => {
  for (const field of ['commandsOutsideRunbook', 'operatorInterventions', 'tierOneFreshRuns', 'tierTwoFreshRuns', 'skippedRuns'] as const) {
    for (const value of [Number.NaN, Infinity, -Infinity, -1, 1.5]) {
      const problems = phase15ClosureProblems(entry, { ...green, [field]: value }, []);
      assert(problems.some((p) => p.includes(`DOMAIN ${field}`)), `${field} accepted ${String(value)}`);
    }
  }
});

test('soak must run iff required, sequences are exactly three with zero skips, and review must ACCEPT', () => {
  assert(phase15ClosureProblems(entry, { ...green, soakRequired: true, soakRan: false }, []).some((p) => p.includes('C13')), 'false soak requirement accepted');
  assert(phase15ClosureProblems(entry, green, ['deploy/projection-alpha.sh']).some((p) => p.includes('C13')), 'required soak skipped');
  const soaked = { ...green, soakRequired: true, soakRan: true };
  assertEq(phase15ClosureProblems(entry, soaked, ['deploy/projection-alpha.sh']).length, 0, 'required soak did not close');
  assert(phase15ClosureProblems(entry, soaked, []).some((p) => p.includes('C13')), 'unrequired soak silently accepted');
  assert(phase15ClosureProblems(entry, { ...green, tierOneFreshRuns: 2 }, []).some((p) => p.includes('C14')), 'two tier-one runs accepted');
  assert(phase15ClosureProblems(entry, { ...green, skippedRuns: 1 }, []).some((p) => p.includes('C14')), 'skip accepted');
  assert(phase15ClosureProblems(entry, { ...green, reviewDisposition: 'reject' }, []).some((p) => p.includes('C17')), 'rejected review closed');
});

h.section('document, CLI and inventory');

test('document preserves preparation/run/closure boundaries and existing control surfaces', () => {
  const doc = read('docs/PROJECTION_PHASE_15_RELEASE_AND_ROLLBACK.md');
  for (const text of ['CONTROL PLANE ONLY', 'PHASE 15 IS NOT RUN AND NOT CLOSED', 'projection-alpha.sh', 'phase9RequiresSoakRerun', 'independent']) {
    assert(doc.includes(text), `document misses ${text}`);
  }
});

test('CLI reports a value-silent ready plan and rejects unknown schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projection-p15-'));
  const cli = join(root, 'src/ops/projection-phase15-plan-cli.ts');
  try {
    const input = join(dir, 'plan.json');
    writeFileSync(input, JSON.stringify({ entry, changedPaths: ['src/core/projection/phase14.ts'] }));
    const run = spawnSync(process.execPath, ['--import', 'tsx', cli, '--input', input, '--json'], { cwd: root, encoding: 'utf8' });
    assertEq(run.status, 0, `ready CLI: ${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assertEq(report.status, 'READY_TO_PREPARE', 'CLI status');
    assertEq(report.changedPathCount, 1, 'path count');
    assert(!run.stdout.includes('src/core/projection/phase14.ts'), 'CLI echoed changed path');
    writeFileSync(input, JSON.stringify({ entry, changedPaths: [], secret: true }));
    const bad = spawnSync(process.execPath, ['--import', 'tsx', cli, '--input', input], { cwd: root, encoding: 'utf8' });
    assertEq(bad.status, 4, 'unknown field was not refused');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('suite and scripts are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-phase15'], 'tsx test/projection-phase15.ts', 'test script');
  assertEq(pkg.scripts['ops:projection-phase15-plan'], 'tsx src/ops/projection-phase15-plan-cli.ts', 'ops script');
  assert(AGGREGATE_SUITE_COMMAND.includes('test/projection-phase15.ts'), 'suite not in aggregate');
});

await h.finish();
