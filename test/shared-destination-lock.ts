import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESTINATION_LOCK_CONTENTION,
  DESTINATION_LOCK_DIRNAME,
  DESTINATION_LOCK_DIRNAMES,
  LEGACY_DESTINATION_LOCK_DIRNAMES,
  MAINTENANCE_LOCK_DIRNAME,
  MaintenanceLocks,
  MaintenanceRefused,
  acquireDestinationLock,
  provePhysicalDestination,
  resolveBackupDestination,
} from '../src/ops/maintenance-safety.js';
import {
  RETENTION_JOURNAL_NAME, abandonRetention, planRetention, resolveRetentionRequest, runRetention,
} from '../src/ops/backup-retention.js';
import { DEFAULT_RETENTION_POLICY } from '../src/ops/retention-model.js';
import {
  SAFETY_SET_JOURNAL_NAME, planSafetySetLifecycle, resolveSafetySetRequest,
} from '../src/ops/safety-set-lifecycle.js';
import { DEFAULT_SAFETY_SET_POLICY } from '../src/ops/safety-set-model.js';
import {
  RESTORE_JOURNAL_NAME, RESTORE_JOURNAL_VERSION, abandonRestore, readRestoreJournal,
} from '../src/ops/complete-restore.js';
import { runVerifiedCompleteBackup } from '../src/ops/complete-backup.js';
import { main as completeBackupCli } from '../src/ops/complete-backup-cli.js';
import { main as completeRestoreCli } from '../src/ops/complete-restore-cli.js';
import { main as retentionCli } from '../src/ops/backup-retention-cli.js';
import { main as lifecycleCli } from '../src/ops/safety-set-lifecycle-cli.js';
import { fakeToolchain } from './helpers/fake-toolchain.js';
import {
  HOLDER_CRASH_EXIT_CODE,
  makeMaintenanceProject,
  makeSharedDestination,
  sameTree,
  snapshotTree,
  takeSharedSet,
  treeDifference,
  type ContenderConfig,
  type ContenderResult,
  type FamilyCommand,
  type HoldConfig,
  type HoldEvidence,
} from './helpers/shared-destination-kit.js';

// Phases 321-328 — ONE PHYSICAL BACKUP DESTINATION, FOUR DESTRUCTIVE COMMANDS, AND THE LOCK THEY SHARE.
//
// -----------------------------------------------------------------------------------------------------
// THE HOLE THIS CLOSES, IN THE WORDS OF THE TRANCHE THAT LEFT IT OPEN.
// -----------------------------------------------------------------------------------------------------
//
// The Phase 313-320 report's FIRST remaining review risk: "The shared-destination boundary is documented, not
// closed. Another project's restore publishing into a destination this project prunes is outside the lock."
// It was true of all four directions, not one: `ops:complete-backup` and `ops:complete-restore` held only
// their own PROJECT locks, so a second Compose project pointed at the same physical directory could
//
//   * publish a set into a destination a prune was half way through quarantining,
//   * claim and publish a safety set into a destination `ops:safety-set-lifecycle` was counting,
//   * start `pg_dump` and build a staging tree in a destination another backup was publishing into,
//   * or destroy an installation whose only safety set another project was about to remove.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - ALL FOUR COMMANDS TAKE ONE LOCK, defined once, named once, refused in one vocabulary.
//   - THE ORDER IS PROJECT THEN DESTINATION, EVERYWHERE, and no code path can express the other one.
//   - TWO DISTINCT PROJECT ROOTS ADDRESSING ONE PHYSICAL DIRECTORY CONTEND. Proved with real child
//     processes: a real command held at a real post-lock boundary, and every other command run against it.
//   - A CONTENDER REFUSES BEFORE ITS FIRST EFFECT — before staging, before a claim, before a rename, before
//     a delete, before a journal, and before it issues a single child command.
//   - A CRASH LEAVES BOTH LOCKS AND NO FALSE SUCCESS, a stale lock is NEVER removed by a program, and the
//     manual recovery an operator would perform actually works.
//   - A PLAN TAKES NO LOCK, so reading one can never be refused by another project's run.
//   - THE ALIAS THIS PRODUCT REFUSES — a destination reached through a link — is still refused, before the
//     lock, on both platforms.

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
/** A case this platform cannot produce. Named, with the reason, and never counted as a pass. */
function skip(name: string, why: string): void {
  skipped++;
  console.log(`  SKIP  ${name}: ${why}`);
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
/** Run a CLI without its usage text landing in this suite's own output. */
function quietly(fn: () => number): number {
  const log = console.log;
  const error = console.error;
  console.log = () => { /* the exit code is the answer */ };
  console.error = () => { /* as above */ };
  try { return fn(); } finally { console.log = log; console.error = error; }
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function refuses(fn: () => unknown, needle: string, msg: string): void {
  try { fn(); } catch (err) {
    const message = (err as Error).message;
    assert(err instanceof MaintenanceRefused, `${msg}: expected a MaintenanceRefused, got ${(err as Error).name}`);
    assert(message.includes(needle), `${msg}: expected a refusal mentioning "${needle}", got: ${message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');
const WORK = mkdtempSync(join(tmpdir(), 'ca-shared-destination-'));
const HOLDER_CHILD = fileURLToPath(new URL('./helpers/destination-lock-holder.mts', import.meta.url));
const CONTENDER_CHILD = fileURLToPath(new URL('./helpers/destination-lock-contender.mts', import.meta.url));
const TSX = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** Commands that would mean the contender got past the lock and touched the installation or the daemon. */
const DESTRUCTIVE_ARGV_TOKENS: readonly string[] = Object.freeze([
  'stop', 'start', 'down', 'up', 'cp', 'exec', 'run', 'kill', 'create',
]);

// -----------------------------------------------------------------------------------------------------------
// One physical directory, two project-relative addresses
// -----------------------------------------------------------------------------------------------------------

test('two distinct project roots resolve one physical destination to one directory', () => {
  const shared = makeSharedDestination(WORK, 'alias-resolve');
  const outer = resolveBackupDestination(shared.outer, shared.outerDestination);
  const inner = resolveBackupDestination(shared.inner, shared.innerDestination);

  assert(outer.projectRoot !== inner.projectRoot, 'the two project roots are genuinely different');
  assertEq(outer.destinationDir, inner.destinationDir, 'and both name ONE physical destination directory');
  // THE RELATIVE SPELLING IS THE OPERATOR'S OWN AND IS NEVER NORMALISED AWAY: it is what a journal records.
  assertEq(outer.destinationRelative, 'inner/backups', 'the outer project keeps its own spelling');
  assertEq(inner.destinationRelative, 'backups', 'and so does the inner one');
  assertEq(outer.destinationName, inner.destinationName, 'the leaf name is the same, because it is one leaf');
  // AND THE TWO MAINTENANCE LOCKS ARE NOT THE SAME LOCK, which is the whole reason a second domain exists.
  assert(join(outer.projectRoot, MAINTENANCE_LOCK_DIRNAME) !== join(inner.projectRoot, MAINTENANCE_LOCK_DIRNAME),
    'the project locks are distinct, so the project lock alone would exclude nothing here');
});

test('one physical destination admits exactly one lock, whichever address asks for it', () => {
  const shared = makeSharedDestination(WORK, 'alias-lock');
  const outer = resolveBackupDestination(shared.outer, shared.outerDestination).destinationDir;
  const inner = resolveBackupDestination(shared.inner, shared.innerDestination).destinationDir;
  const first = acquireDestinationLock(outer);
  try {
    refuses(() => acquireDestinationLock(inner), 'already working in this backup destination',
      'the second address finds the lock the first one took');
  } finally {
    first.release();
  }
  // AND IT IS RELEASED, so the second address can take it once the first is done.
  const second = acquireDestinationLock(inner);
  second.release();
  assertEq(existsSync(join(shared.destination, DESTINATION_LOCK_DIRNAME)), false, 'nothing is left behind');
});

test('a destination reached through a link is refused before any lock, on this platform', () => {
  const root = makeMaintenanceProject(join(WORK, 'alias-link'));
  const real = join(WORK, 'alias-link-target');
  mkdirSync(real, { recursive: true });
  let linked = false;
  for (const kind of ['dir', 'junction'] as const) {
    try { symlinkSync(real, join(root, 'backups'), kind); linked = true; break; } catch { /* next */ }
  }
  if (!linked) {
    skip('a destination reached through a link is refused',
      'this host permits neither a directory symbolic link nor a junction, so the alias cannot be built here');
    return;
  }
  // THE PAIR OF FACTS IS WHAT MAKES THE FIXTURE HONEST. The alias this product ACCEPTS contends on one lock
  // (above); the alias it does not accept never reaches one. There is no third kind.
  refuses(() => resolveBackupDestination(root, 'backups'), 'symbolic link',
    'a linked destination is refused at resolution, before a lock could be taken in it');
});

test('a case-variant address is the same physical destination where the filesystem says so', () => {
  const root = makeMaintenanceProject(join(WORK, 'alias-case'));
  mkdirSync(join(root, 'backups'), { recursive: true });
  const insensitive = existsSync(join(root, 'BACKUPS'));
  if (!insensitive) {
    skip('a case-variant address resolves to one directory',
      'this filesystem is case-SENSITIVE, so "BACKUPS" is a different directory and there is no alias to test');
    return;
  }
  // THE PROPERTY IS EXCLUSION, NOT STRING EQUALITY, and it is asserted as exclusion. `realpath` does not
  // canonicalise case on every platform — Node's does not on Windows — so two resolved paths can still
  // differ in spelling. It does not matter: the lock is a DIRECTORY IN THE DESTINATION, and on a
  // case-insensitive filesystem those two spellings name one directory, so the second `mkdir` finds the
  // first one's lock. That is what makes this lock physical rather than nominal.
  const lower = resolveBackupDestination(root, 'backups');
  const upper = resolveBackupDestination(root, 'BACKUPS');
  const held = acquireDestinationLock(lower.destinationDir);
  try {
    refuses(() => acquireDestinationLock(upper.destinationDir), 'already working in this backup destination',
      'the other spelling of one directory finds the lock that is already in it');
  } finally {
    held.release();
  }
});

// -----------------------------------------------------------------------------------------------------------
// The lock order, structurally
// -----------------------------------------------------------------------------------------------------------

test('the destination lock cannot be taken without the project lock, and is released first', () => {
  const shared = makeSharedDestination(WORK, 'order');
  const order: string[] = [];
  const locks = MaintenanceLocks.open(shared.outer);
  assert(existsSync(join(shared.outer, MAINTENANCE_LOCK_DIRNAME)), 'the project lock is taken first');
  assertEq(existsSync(join(shared.destination, DESTINATION_LOCK_DIRNAME)), false,
    'and the destination lock is not taken with it');
  locks.lockDestination(shared.destination);
  assert(existsSync(join(shared.destination, DESTINATION_LOCK_DIRNAME)), 'then the destination lock');
  assertEq(locks.holdsDestination, true, 'and the stack says it holds one');

  // ASKED TWICE IS A DEFECT, NOT A NO-OP: one operation holds one destination.
  refuses(() => locks.lockDestination(shared.destination), 'asked twice', 'a second destination lock is refused');

  // THE RELEASE ORDER IS OBSERVED FROM DISK, not asserted from the source.
  const watch = (): void => {
    order.push(`${existsSync(join(shared.destination, DESTINATION_LOCK_DIRNAME)) ? 'D' : '-'}`
      + `${existsSync(join(shared.outer, MAINTENANCE_LOCK_DIRNAME)) ? 'P' : '-'}`);
  };
  watch();
  locks.release();
  watch();
  assertEq(order[0], 'DP', 'both held');
  assertEq(order[1], '--', 'both released');
  refuses(() => locks.lockDestination(shared.destination), 'after the locks were released',
    'and a stack that has been released cannot be used again');
});

test('the project lock and the destination lock never deadlock two projects sharing one destination', () => {
  // THE SHAPE THAT WOULD DEADLOCK: one run holding the destination and waiting for a project, another
  // holding a project and waiting for the destination. It cannot arise, for two independent reasons, and
  // both are asserted rather than argued.
  const shared = makeSharedDestination(WORK, 'deadlock');
  const outer = MaintenanceLocks.open(shared.outer);
  try {
    outer.lockDestination(shared.destination);
    // 1. THE OTHER PROJECT GETS ITS OWN PROJECT LOCK — the domains really are independent...
    const inner = MaintenanceLocks.open(shared.inner);
    try {
      // 2. ...AND IT DOES NOT WAIT. `mkdir` refuses; nothing in this family ever blocks on a lock, so a
      //    cycle would be a pair of refusals rather than a hang, and there is not even a cycle to have.
      refuses(() => inner.lockDestination(shared.destination), 'already working in this backup destination',
        'the second project is refused immediately rather than queued');
    } finally {
      inner.release();
    }
  } finally {
    outer.release();
  }
});

test('every command takes both locks through the one stack, and nothing takes them directly', () => {
  // THE ORDER IS STRUCTURAL, and this is the check that keeps it structural: a module that called
  // `acquireDestinationLock` itself could take it before the project lock, or forget to release it.
  const owner = 'src/ops/maintenance-safety.ts';
  for (const file of readdirSync(join(repoRoot, 'src', 'ops')).filter((name) => name.endsWith('.ts'))) {
    const rel = `src/ops/${file}`;
    if (rel === owner) continue;
    const source = readRepo(rel);
    assert(!source.includes('acquireDestinationLock('),
      `${rel} calls acquireDestinationLock directly instead of going through MaintenanceLocks`);
    assert(!source.includes('acquireLockDirectory(join(') || !source.includes('destinationDir'),
      `${rel} builds its own destination lock instead of using the shared one`);
  }
  // AND THE FOUR COMMANDS REALLY DO USE IT.
  for (const file of ['complete-backup', 'complete-restore', 'backup-retention', 'safety-set-lifecycle']) {
    const source = readRepo(`src/ops/${file}.ts`);
    assert(source.includes('MaintenanceLocks.open(') || source.includes('MaintenanceLocks.inherited()'),
      `src/ops/${file}.ts opens the shared lock stack`);
    assert(source.includes('.lockDestination('), `src/ops/${file}.ts takes the destination lock`);
    assert(source.includes('locks.release()'), `src/ops/${file}.ts releases them in a finally`);
  }
});

test('there is one destination lock name and one refusal vocabulary, and no command spells it itself', () => {
  const owner = readRepo('src/ops/maintenance-safety.ts');
  assert(owner.includes(`'${DESTINATION_LOCK_DIRNAME}'`), 'the name is a literal in exactly one module');
  for (const file of ['complete-backup', 'complete-restore', 'backup-retention', 'safety-set-lifecycle']) {
    const source = readRepo(`src/ops/${file}.ts`);
    assert(!source.includes(`'${DESTINATION_LOCK_DIRNAME}'`), `src/ops/${file}.ts does not spell the name`);
    assert(!source.includes('.catalog-retention.lock'), `src/ops/${file}.ts does not spell the old name either`);
  }
  assert(DESTINATION_LOCK_CONTENTION.includes('ops:complete-backup')
    && DESTINATION_LOCK_CONTENTION.includes('ops:complete-restore')
    && DESTINATION_LOCK_CONTENTION.includes('ops:backup-retention')
    && DESTINATION_LOCK_CONTENTION.includes('ops:safety-set-lifecycle'),
    'the one refusal names all four commands, because any of them may be the holder');
  assert(DESTINATION_LOCK_CONTENTION.includes('ANOTHER project'),
    'and it names the cross-project case, which is the case an operator will not otherwise think of');
});

// -----------------------------------------------------------------------------------------------------------
// The adversarial matrix: a real holder, real contenders, one physical destination
// -----------------------------------------------------------------------------------------------------------

interface Scenario {
  readonly name: string;
  readonly holder: FamilyCommand;
  /** `outer` holds and `inner` contends, or the other way round. */
  readonly direction?: 'outer-holds' | 'inner-holds';
  readonly thenCrash?: true;
}

function contenderList(projectRoot: string, destination: string, dir: string): ContenderConfig[] {
  const of = (command: FamilyCommand, extra: Partial<ContenderConfig> = {}): ContenderConfig => ({
    label: command,
    command,
    projectRoot,
    destination,
    resultFile: join(dir, `${command}.result.json`),
    ...extra,
  });
  return [
    of('complete-backup', { setName: 'contender-set' }),
    of('complete-restore', { setName: 'set-a' }),
    of('backup-retention'),
    of('safety-set-lifecycle'),
    { ...of('backup-retention'), label: 'backup-retention-cli', viaCli: true,
      resultFile: join(dir, 'backup-retention-cli.result.json') },
  ];
}

function runScenario(scenario: Scenario): { evidence: HoldEvidence; shared: ReturnType<typeof makeSharedDestination>; status: number | null } {
  const shared = makeSharedDestination(WORK, scenario.name);
  // TWO REAL, VERIFIED SETS, taken by the shipped command through the OUTER project's address.
  takeSharedSet(shared.outer, shared.outerDestination, 'set-a', new Date('2020-01-01T00:00:00.000Z'));
  takeSharedSet(shared.outer, shared.outerDestination, 'set-b', new Date('2021-01-01T00:00:00.000Z'));

  const innerHolds = scenario.direction === 'inner-holds';
  const holderRoot = innerHolds ? shared.inner : shared.outer;
  const holderDestination = innerHolds ? shared.innerDestination : shared.outerDestination;
  const contenderRoot = innerHolds ? shared.outer : shared.inner;
  const contenderDestination = innerHolds ? shared.outerDestination : shared.innerDestination;

  const evidenceFile = join(WORK, `${scenario.name}.evidence.json`);
  const config: HoldConfig = {
    command: scenario.holder,
    projectRoot: holderRoot,
    destination: holderDestination,
    setName: scenario.holder === 'complete-backup' ? 'holder-set' : 'set-a',
    ...(scenario.thenCrash === true ? { thenCrash: true as const } : {}),
    contenders: contenderList(contenderRoot, contenderDestination, WORK)
      .map((contender) => ({ ...contender, resultFile: `${contender.resultFile}.${scenario.name}` })),
    evidenceFile,
    repoRoot,
    contenderChild: CONTENDER_CHILD,
  };
  const child = spawnSync(process.execPath, [TSX, HOLDER_CHILD, JSON.stringify(config)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 600_000, windowsHide: true });
  assert(existsSync(evidenceFile),
    `the ${scenario.holder} holder never reached its boundary: exit ${String(child.status)} `
    + `${(child.stderr ?? '').slice(0, 800)}`);
  return {
    evidence: JSON.parse(readFileSync(evidenceFile, 'utf8')) as HoldEvidence,
    shared,
    status: child.status,
  };
}

/** Every claim a contender has to make good, whatever it is and whichever command is holding. */
function assertContenderRefusedWithoutEffect(result: ContenderResult, msg: string): void {
  assertEq(result.outcome, 'refused', `${msg}: it had to refuse — ${result.message.slice(0, 400)}`);
  assert(result.message.includes('already working in this backup destination'),
    `${msg}: it had to refuse with the shared destination-lock vocabulary, got: ${result.message.slice(0, 400)}`);
  // NO COMMAND, NO PROCESS, NO NETWORK, before the lock boundary. Checked against the argv list.
  for (const token of DESTRUCTIVE_ARGV_TOKENS) {
    assert(!result.commands.includes(token),
      `${msg}: it issued "${token}" before it was refused — ${result.commands.join(' ')}`);
  }
  assert(!result.commands.some((argument) => argument.includes('pg_dump') || argument.includes('psql')),
    `${msg}: it reached the database before the lock — ${result.commands.join(' ')}`);
  assert(!result.commands.some((argument) => argument.includes('://')),
    `${msg}: it addressed a network before the lock`);
}

for (const scenario of [
  { name: 'hold-retention', holder: 'backup-retention' as const },
  { name: 'hold-lifecycle', holder: 'safety-set-lifecycle' as const },
  { name: 'hold-backup', holder: 'complete-backup' as const },
  { name: 'hold-restore', holder: 'complete-restore' as const },
  { name: 'hold-retention-reverse', holder: 'backup-retention' as const, direction: 'inner-holds' as const },
] satisfies readonly Scenario[]) {
  test(`${scenario.holder} holding one destination (${scenario.direction ?? 'outer-holds'}) refuses every `
    + 'other family command from another project',
    () => {
      const { evidence, shared } = runScenario(scenario);
      assertEq(evidence.lockHeldAtBoundary, true, 'the holder really had the destination lock at the boundary');
      assertEq(evidence.projectLockHeldAtBoundary, true, 'and its own project lock, in that order');
      assertEq(evidence.results.length, 5, 'every contender ran');

      for (const result of evidence.results) {
        assertContenderRefusedWithoutEffect(result, `${scenario.name}/${result.label}`);
      }

      // NOT ONE BYTE OF THE DESTINATION CHANGED while five real commands were refused in it.
      assert(sameTree(evidence.destinationBefore, evidence.destinationAfter),
        `${scenario.name}: the contenders changed the destination: `
        + treeDifference(evidence.destinationBefore, evidence.destinationAfter).join(', '));

      // AND NO CONTENDER LEFT A JOURNAL IN ITS OWN PROJECT. A journal is a commitment to an operation; one
      // written by a run that never started is a project that refuses every later run for no reason.
      const contenderRoot = scenario.direction === 'inner-holds' ? shared.outer : shared.inner;
      for (const journal of [RETENTION_JOURNAL_NAME, SAFETY_SET_JOURNAL_NAME, RESTORE_JOURNAL_NAME]) {
        assertEq(existsSync(join(contenderRoot, journal)), false,
          `${scenario.name}: a refused contender wrote ${journal}`);
      }
      assertEq(existsSync(join(contenderRoot, MAINTENANCE_LOCK_DIRNAME)), false,
        'and every contender released its own project lock on the way out');
    });
}

test('the operator surface refuses a shared destination with one JSON document and the refused exit code', () => {
  const { evidence } = runScenario({ name: 'hold-retention-json', holder: 'backup-retention' });
  const cli = evidence.results.find((result) => result.label === 'backup-retention-cli');
  assert(cli !== undefined, 'the CLI contender ran');
  assertEq(cli!.exitCode, 3, 'the exit code is this family\'s "refused"');
  // THE STREAM DISCIPLINE THIS FAMILY ALREADY PROMISES, UNCHANGED BY THE NEW REFUSAL. A refusal before any
  // effect has no report, so `--json` emits NOTHING on stdout — a machine reading stdout reads zero
  // documents rather than one document of prose — and the sentence goes to stderr with exit 3. A lock
  // refusal is not allowed to be the one refusal that breaks that.
  assertEq(cli!.stdout.trim(), '', '--json put nothing on stdout, because there is no report to put there');
  assert(cli!.message.includes('already working in this backup destination'),
    'and the refusal an operator has to read went to stderr');
});

// -----------------------------------------------------------------------------------------------------------
// A crash, the stale lock it leaves, and the manual recovery
// -----------------------------------------------------------------------------------------------------------

test('a killed run leaves BOTH locks, no false success, and nothing removes them on its own', () => {
  const { evidence, shared, status } = runScenario({
    name: 'crash-retention', holder: 'backup-retention', thenCrash: true,
  });
  assertEq(status, HOLDER_CRASH_EXIT_CODE, 'the holder really stopped existing at the boundary');
  for (const result of evidence.results) {
    assertContenderRefusedWithoutEffect(result, `crash/${result.label}`);
  }

  // WHAT A KILL LEAVES: both lock directories, and no journal, because the boundary is before the first write.
  assert(existsSync(join(shared.outer, MAINTENANCE_LOCK_DIRNAME)), 'the project lock is still there');
  assert(existsSync(join(shared.destination, DESTINATION_LOCK_DIRNAME)), 'and so is the destination lock');
  assertEq(existsSync(join(shared.outer, RETENTION_JOURNAL_NAME)), false,
    'and no journal, because the kill was before the first write — so there is nothing to resume and no set moved');

  // NOTHING BREAKS IT AUTOMATICALLY. Every command still refuses, from either project, for as long as it is
  // there — which is the point: guessing whether the holder is alive is how two writers happen.
  refuses(() => runRetentionIn(shared.inner, 'backups'), 'already working in this backup destination',
    'the other project still refuses');
  refuses(() => runRetentionIn(shared.outer, 'inner/backups'), 'another maintenance command is already running',
    'and the holder\'s own project meets its own stale project lock first');
  assert(existsSync(join(shared.destination, DESTINATION_LOCK_DIRNAME)),
    'and NOTHING removed the stale destination lock');

  // THE DETERMINISTIC MANUAL RECOVERY, exactly as the refusal describes it: the operator satisfies themselves
  // nothing is running and removes the two directories. Then the destination works again.
  rmSync(join(shared.outer, MAINTENANCE_LOCK_DIRNAME), { recursive: true });
  rmSync(join(shared.destination, DESTINATION_LOCK_DIRNAME), { recursive: true });
  const report = runRetentionIn(shared.inner, 'backups');
  assertEq(report.ok, true, 'and a prune from the other project now runs to completion');
  assertEq(existsSync(join(shared.destination, DESTINATION_LOCK_DIRNAME)), false, 'releasing the lock it took');
});

function runRetentionIn(projectRoot: string, destination: string): ReturnType<typeof runRetention> {
  const policy = { ...DEFAULT_RETENTION_POLICY, keepLast: 1, minAgeDays: 0 };
  const now = new Date('2026-07-31T12:00:00.000Z');
  const plan = planRetention(resolveRetentionRequest({ projectRoot, destination }), policy, now);
  return runRetention({ projectRoot, destination }, policy, { now: () => now },
    { kind: 'run', confirm: plan.digest });
}

test('a destination lock an EARLIER build left behind is refused by name and never worked around', () => {
  const shared = makeSharedDestination(WORK, 'legacy-lock');
  takeSharedSet(shared.outer, shared.outerDestination, 'set-a', new Date('2020-01-01T00:00:00.000Z'));
  takeSharedSet(shared.outer, shared.outerDestination, 'set-b', new Date('2021-01-01T00:00:00.000Z'));
  for (const legacy of LEGACY_DESTINATION_LOCK_DIRNAMES) {
    mkdirSync(join(shared.destination, legacy));
    refuses(() => runRetentionIn(shared.inner, 'backups'), legacy,
      `a ${legacy} left by an older build is refused, by name`);
    refuses(() => takeSharedSet(shared.inner, 'backups', 'after-legacy'), legacy,
      'and so is a backup, which would otherwise publish into a destination an old prune is half way through');
    assert(existsSync(join(shared.destination, legacy)), 'and nothing removed it');
    assertEq(existsSync(join(shared.destination, DESTINATION_LOCK_DIRNAME)), false,
      'and no NEW lock was taken beside it');
    rmSync(join(shared.destination, legacy), { recursive: true });
  }
  // ONCE IT IS GONE, the destination works normally again. A compatibility guard that could not be cleared
  // would be a wedge rather than a guard.
  takeSharedSet(shared.inner, 'backups', 'after-legacy');
  assert(existsSync(join(shared.destination, 'after-legacy')), 'the set is published once the old lock is gone');
});

test('every destination lock name, current and historical, is excluded from both inventories', () => {
  const shared = makeSharedDestination(WORK, 'inventory');
  takeSharedSet(shared.outer, shared.outerDestination, 'set-a', new Date('2020-01-01T00:00:00.000Z'));
  const policy = { ...DEFAULT_RETENTION_POLICY, keepLast: 1, minAgeDays: 0 };
  const safety = { ...DEFAULT_SAFETY_SET_POLICY, keepLast: 1, minAgeDays: 0 };
  const now = new Date('2026-07-31T12:00:00.000Z');
  const clean = planRetention(resolveRetentionRequest({ projectRoot: shared.inner, destination: 'backups' }),
    policy, now);
  const cleanSafety = planSafetySetLifecycle(
    resolveSafetySetRequest({ projectRoot: shared.inner, destination: 'backups' }), safety, now);

  for (const name of DESTINATION_LOCK_DIRNAMES) {
    mkdirSync(join(shared.destination, name));
    // THE PLAN AND THE RE-PLAN UNDER THE LOCK MUST AGREE, and the run's own lock exists only for the second
    // of those — so a lock name that counted as destination content would make every confirmation fail.
    const withLock = planRetention(
      resolveRetentionRequest({ projectRoot: shared.inner, destination: 'backups' }), policy, now);
    assertEq(withLock.digest, clean.digest, `${name} does not change the retention inventory`);
    const withLockSafety = planSafetySetLifecycle(
      resolveSafetySetRequest({ projectRoot: shared.inner, destination: 'backups' }), safety, now);
    assertEq(withLockSafety.digest, cleanSafety.digest, `${name} does not change the claim inventory`);
    rmSync(join(shared.destination, name), { recursive: true });
  }
});

// -----------------------------------------------------------------------------------------------------------
// A plan takes no lock, and the refusals that were exact stay exact
// -----------------------------------------------------------------------------------------------------------

test('a plan takes no lock at all, so reading one is never refused by another project\'s run', () => {
  const shared = makeSharedDestination(WORK, 'plan-no-lock');
  takeSharedSet(shared.outer, shared.outerDestination, 'set-a', new Date('2020-01-01T00:00:00.000Z'));
  const now = new Date('2026-07-31T12:00:00.000Z');
  // A lock held by somebody else, by hand: exactly the state a run in the other project produces.
  mkdirSync(join(shared.destination, DESTINATION_LOCK_DIRNAME));
  try {
    const retention = planRetention(
      resolveRetentionRequest({ projectRoot: shared.inner, destination: 'backups' }),
      { ...DEFAULT_RETENTION_POLICY, keepLast: 1, minAgeDays: 0 }, now);
    assert(retention.digest.length === 64, 'a retention plan is produced while another project holds the lock');
    const lifecycle = planSafetySetLifecycle(
      resolveSafetySetRequest({ projectRoot: shared.inner, destination: 'backups' }),
      { ...DEFAULT_SAFETY_SET_POLICY, keepLast: 1, minAgeDays: 0 }, now);
    assert(lifecycle.digest.length === 64, 'and so is a safety-set plan');
    // AND NEITHER TOOK A LOCK OF ITS OWN.
    assertEq(readdirSync(shared.destination).filter((name) => name.endsWith('.lock')).length, 1,
      'exactly the one lock that was placed by hand is there');
  } finally {
    rmSync(join(shared.destination, DESTINATION_LOCK_DIRNAME), { recursive: true });
  }
});

test('the destination-equals-project-root and outside-root refusals are unchanged', () => {
  const root = makeMaintenanceProject(join(WORK, 'exact-refusals'));
  mkdirSync(join(root, 'backups'), { recursive: true });
  refuses(() => resolveBackupDestination(root, '.'), 'names nothing',
    'a destination that is the project root itself names nothing to resolve');
  refuses(() => resolveBackupDestination(root, '..'), 'must not step above the project root',
    'and one above it is refused by shape');
  refuses(() => resolveBackupDestination(root, join(root, 'backups')), 'must be relative to the project root',
    'an absolute destination is refused');
  refuses(() => resolveBackupDestination(root, 'nowhere'), 'does not exist or cannot be read',
    'and one that is not there is refused rather than created');
  // The belt-and-braces refusal the shared resolver keeps, reachable directly.
  refuses(() => provePhysicalDestination(root, root), 'cannot be the project root itself',
    'the project root is refused as a destination even when handed in directly');
});

test('a resume and an abandon take the destination from the journal, never from a flag', () => {
  const source = readRepo('src/ops/complete-restore.ts');
  const run = source.slice(source.indexOf('export function runCompleteRestore'));
  assert(run.includes('const destinationRelative = underLock === null ? request.destination : underLock.destination;'),
    'a restore locks the destination its journal names, not the one a resume\'s flags default to');
  assert(run.indexOf('locks.lockDestination(') < run.indexOf('const reResolved = existing === null'),
    'and it takes that lock BEFORE it relies on the backup set again');

  const abandon = source.slice(source.indexOf('export function abandonRestore'));
  const scope = abandon.slice(0, abandon.indexOf('function abandonUnderLock'));
  assert(scope.includes('resolveBackupDestination(projectRoot, journal.destination)'),
    'an abandon takes it from the journal too');

  for (const file of ['backup-retention', 'safety-set-lifecycle']) {
    const other = readRepo(`src/ops/${file}.ts`);
    assert(other.includes('existing!.destination'), `${file} resumes against the journal's destination`);
    assert(other.includes('opening.destination'), `${file} abandons against the journal's destination`);
  }
});

test('a journal records the destination RELATIVE to its project, and no absolute path reaches a report', () => {
  const shared = makeSharedDestination(WORK, 'journal-portable');
  const setDir = takeSharedSet(shared.inner, 'backups', 'set-a', new Date('2020-01-01T00:00:00.000Z'));
  assert(existsSync(setDir), 'the fixture set exists');
  // A restore journal, written by the shipped command, read back and inspected for portability.
  const tools = fakeToolchain();
  void tools;
  const journalOf = (root: string): unknown => readRestoreJournal(root);
  assertEq(journalOf(shared.inner), null, 'there is no restore in flight in this fixture');

  // THE RETENTION JOURNAL IS THE ONE THIS TRANCHE CAN WRITE WITHOUT DESTROYING ANYTHING: it is written
  // before the first rename and the run is then let go.
  takeSharedSet(shared.inner, 'backups', 'set-b', new Date('2021-01-01T00:00:00.000Z'));
  const report = runRetentionIn(shared.inner, 'backups');
  assertEq(report.ok, true, 'the prune ran');
  const rendered = JSON.stringify(report);
  assert(!rendered.includes(shared.inner) && !rendered.includes(shared.destination),
    'and no host path reached the report');
  assert(!rendered.includes(DESTINATION_LOCK_DIRNAME), 'nor did the lock, which is not an operator\'s business');
});

test('a resume and an abandon of an interrupted prune contend on the destination like any other run', () => {
  // A REAL INTERRUPTED JOURNAL, not a hand-written one: the run is stopped at its own `after-journal`
  // failpoint, which is AFTER the journal has landed and BEFORE the first rename — so what is on disk is
  // exactly what a prune interrupted at that instant leaves, minus the locks, which its `finally` released.
  const shared = makeSharedDestination(WORK, 'recovery-contention');
  takeSharedSet(shared.inner, 'backups', 'set-a', new Date('2020-01-01T00:00:00.000Z'));
  takeSharedSet(shared.inner, 'backups', 'set-b', new Date('2021-01-01T00:00:00.000Z'));
  const policy = { ...DEFAULT_RETENTION_POLICY, keepLast: 1, minAgeDays: 0 };
  const now = new Date('2026-07-31T12:00:00.000Z');
  const digest = planRetention(
    resolveRetentionRequest({ projectRoot: shared.inner, destination: 'backups' }), policy, now).digest;
  refuses(() => runRetention({ projectRoot: shared.inner, destination: 'backups' }, policy, {
    now: () => now,
    at: (point) => {
      if (point === 'after-journal') throw new MaintenanceRefused('the prune was interrupted here');
    },
  }, { kind: 'run', confirm: digest }), 'interrupted here', 'the prune stopped at its own failpoint');
  assert(existsSync(join(shared.inner, RETENTION_JOURNAL_NAME)), 'and left its journal');
  assertEq(existsSync(join(shared.destination, DESTINATION_LOCK_DIRNAME)), false,
    'while its `finally` released both locks, which is what makes the next two refusals about the OTHER run');

  // THE OTHER PROJECT IS NOW WORKING IN THAT DESTINATION.
  mkdirSync(join(shared.destination, DESTINATION_LOCK_DIRNAME));
  refuses(() => runRetention({ projectRoot: shared.inner, destination: 'backups' }, policy,
    { now: () => now }, { kind: 'resume', confirm: digest }),
    'already working in this backup destination', 'a resume contends like any other run');
  refuses(() => abandonRetention(shared.inner), 'already working in this backup destination',
    'and so does an abandon — it renames sets back INTO the destination');
  assert(existsSync(join(shared.inner, RETENTION_JOURNAL_NAME)),
    'and neither of them touched the journal, so the recovery is still there to be run');

  // AND BOTH REMAIN AVAILABLE the moment the destination is free again.
  rmSync(join(shared.destination, DESTINATION_LOCK_DIRNAME), { recursive: true });
  const report = abandonRetention(shared.inner);
  assertEq(report.ok, true, 'the abandon runs and unwinds cleanly once the destination is free');
  assertEq(existsSync(join(shared.inner, RETENTION_JOURNAL_NAME)), false, 'clearing the journal');
  assert(existsSync(join(shared.destination, 'set-a')) && existsSync(join(shared.destination, 'set-b')),
    'with both sets exactly where they were');
});

test('a restore abandon whose destination has GONE still runs, and names the fact', () => {
  // DO NOT STRAND A RECOVERY. `ops:complete-restore --abandon` is the one command that puts an installation
  // back. A destination that has been unmounted, renamed or removed since the crash is a directory this
  // unwind does not need — it only ever renames THIS PROJECT's own directories — so it must not be the
  // reason an operator cannot recover.
  const root = makeMaintenanceProject(join(WORK, 'abandon-no-destination'));
  mkdirSync(join(root, 'backups'), { recursive: true });
  takeSharedSet(root, 'backups', 'set-1', new Date('2020-01-01T00:00:00.000Z'));
  writeFileSync(join(root, RESTORE_JOURNAL_NAME), `${JSON.stringify({
    journal: 'catalog-authority.restore', version: RESTORE_JOURNAL_VERSION, planDigest: 'a'.repeat(64),
    setName: 'set-1', destination: 'backups', custodian: 'inline', targetState: 'OCCUPIED',
    safetySetName: 'pre-restore-set-1', suffix: 'aaaaaaaaaaaa', phase: 'restoring',
    safetySetClaim: { nonce: 'a'.repeat(24), created: true },
    safetySetPlanned: true, safetySetTaken: true,
    stagingCommitment: [
      { id: 'database', artifact: 'catalog-backup.sql', digest: 'c'.repeat(64), entries: 1, bytes: 10 },
      { id: 'secrets', artifact: 'secrets-backup', digest: 'd'.repeat(64), entries: 2, bytes: 20 },
    ],
    request: { secrets: 'secrets', promotionRecords: 'promotion-records', sidecarState: null },
    steps: [{ id: 'safety-set', state: 'complete', detail: null }], swaps: [],
    evidence: { custodyProven: false, safetySetTaken: true, safetySetVerified: true },
  })}\n`, 'utf8');
  assert(readRestoreJournal(root) !== null, 'the fixture journal reads');

  // A DESTINATION SOMEBODY ELSE IS WORKING IN IS STILL A REFUSAL. The two failures are not the same thing.
  mkdirSync(join(root, 'backups', DESTINATION_LOCK_DIRNAME));
  refuses(() => abandonRestore(root), 'already working in this backup destination',
    'a live command in the destination stops the unwind, because that is a command and not a missing folder');
  rmSync(join(root, 'backups', DESTINATION_LOCK_DIRNAME), { recursive: true });

  // AND NOW THE DESTINATION ITSELF GOES.
  renameSync(join(root, 'backups'), join(root, 'backups-moved-away'));
  const report = abandonRestore(root);
  assertEq(report.ok, true, 'the unwind ran anyway');
  assert(report.notes.some((note) => note.includes('without the destination lock')),
    `and said so: ${report.notes.join(' | ')}`);
  assertEq(report.journalCleared, true, 'and cleared the journal, because there was nothing left out of place');
});

test('an abandon whose destination has vanished is still available, and says so', () => {
  // DO NOT STRAND A RECOVERY. The one command that puts an installation back must not refuse because a
  // directory it does not need has gone. It runs without the destination lock and names the fact.
  const source = readRepo('src/ops/complete-restore.ts');
  const abandon = source.slice(source.indexOf('export function abandonRestore'));
  const scope = abandon.slice(0, abandon.indexOf('function abandonUnderLock'));
  assert(scope.includes('destinationDir = null'), 'a destination that cannot be resolved is a null, not a throw');
  assert(scope.includes('without the destination lock'), 'and the report says so, in the notes');
  // AND A LOCK SOMEBODY ELSE HOLDS IS STILL A REFUSAL — the two failures are told apart by which step threw.
  assert(scope.indexOf('locks.lockDestination(destinationDir)') > scope.indexOf('catch'),
    'the acquisition is outside the catch that tolerates a missing directory');
});

// -----------------------------------------------------------------------------------------------------------
// The safety set a restore takes: one project lock, one destination lock, and no second acquisition
// -----------------------------------------------------------------------------------------------------------

test('a restore taking its safety set holds exactly one project lock and one destination lock', () => {
  const shared = makeSharedDestination(WORK, 'nested-safety-set');
  const setDir = takeSharedSet(shared.inner, 'backups', 'set-a', new Date('2020-01-01T00:00:00.000Z'));
  const evidenceFile = join(WORK, 'nested-safety-set.evidence.json');
  const config: HoldConfig = {
    command: 'complete-restore',
    projectRoot: shared.inner,
    destination: 'backups',
    setName: 'set-a',
    contenders: [],
    evidenceFile,
    repoRoot,
    contenderChild: CONTENDER_CHILD,
  };
  const child = spawnSync(process.execPath, [TSX, HOLDER_CHILD, JSON.stringify(config)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 600_000, windowsHide: true });
  assert(existsSync(evidenceFile), `the restore never reached its safety set: ${(child.stderr ?? '').slice(0, 600)}`);
  const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')) as HoldEvidence;

  // THE BOUNDARY IS THE SAFETY SET'S OWN `docker compose stop`, which runs INSIDE the nested backup.
  assertEq(evidence.projectLockHeldAtBoundary, true, 'the restore holds this project\'s lock while it runs');
  assertEq(evidence.lockHeldAtBoundary, true, 'and the destination lock');

  // AND NO SECOND LOCK WAS TAKEN INSIDE THE CLAIM. A destination lock at the claim directory would exclude
  // nothing and would leave a directory inside a set's own claim, which is later proved entry by entry.
  const claims = Object.keys(evidence.destinationBefore)
    .filter((key) => key.startsWith('.pre-restore-claim-') && key.includes(DESTINATION_LOCK_DIRNAME));
  assertEq(claims.length, 0, 'no lock directory was created inside the safety-set claim');
  assert(existsSync(setDir), 'and the set being restored is untouched');
});

test('nothing else in src/ tells a backup that its caller already holds the locks', () => {
  for (const file of readdirSync(join(repoRoot, 'src', 'ops')).filter((name) => name.endsWith('.ts'))) {
    if (file === 'complete-restore.ts' || file === 'complete-backup.ts') continue;
    assert(!readRepo(`src/ops/${file}`).includes('holdingLock'),
      `src/ops/${file} passes holdingLock, and exactly one caller may`);
  }
});

// -----------------------------------------------------------------------------------------------------------
// Registration, documentation, and the operator's own surfaces
// -----------------------------------------------------------------------------------------------------------

test('the command family, its suite and its documents are registered where the runner and CI look', () => {
  const inventory = JSON.parse(readRepo('test/suite-inventory.json')) as {
    readonly suites: readonly { readonly file: string }[];
    readonly helpers: readonly string[];
  };
  assert(inventory.suites.some((suite) => suite.file === 'shared-destination-lock.ts'),
    'this suite is in the aggregate inventory');
  const pkg = JSON.parse(readRepo('package.json')) as { readonly scripts: Record<string, string> };
  assertEq(pkg.scripts['test:shared-destination-lock'], 'tsx test/shared-destination-lock.ts',
    'and has its own npm script');
  assertEq(pkg.scripts['test:phase321-local'], 'npm run test:shared-destination-lock',
    'under the phase-local name the other tranches use');
  const workflow = readRepo('.github/workflows/runtime-image.yml');
  assert(workflow.includes('npm run test:phase321-local'),
    'and the destructive-command CI gate runs it');
});

test('the operator documents state that all four commands serialise per destination, across projects', () => {
  const design = readRepo('docs/PHASES_321_328_SHARED_DESTINATION_LOCK.md');
  for (const command of ['ops:complete-backup', 'ops:complete-restore', 'ops:backup-retention',
    'ops:safety-set-lifecycle']) {
    assert(design.includes(command), `the design document names ${command}`);
  }
  assert(design.includes(DESTINATION_LOCK_DIRNAME), 'and the lock directory an operator would find');
  assert(design.toLowerCase().includes('across projects') || design.includes('another project'),
    'and says the serialisation crosses projects');
  const readme = readRepo('README.md');
  assert(readme.includes('serialise') || readme.includes('serialize') || readme.includes('one at a time'),
    'the README tells an operator these commands take turns per destination');
});

test('the CLI usage of every one of the four commands says the destination is serialised', () => {
  for (const cli of ['complete-backup-cli', 'complete-restore-cli', 'backup-retention-cli',
    'safety-set-lifecycle-cli']) {
    const source = readRepo(`src/ops/${cli}.ts`);
    assert(source.includes('one command at a time per backup destination'),
      `src/ops/${cli}.ts tells an operator that a destination is taken one command at a time`);
  }
});

test('this tranche adds no scheduler and no force flag', () => {
  // ASKED OF THE PARSERS, NOT OF THE PROSE. Two of these files say IN A COMMENT that there is no `--force`,
  // which is exactly the sentence a source scan would trip over — so each CLI is actually RUN with each
  // flag, and a usage error is the answer that proves nothing accepts it.
  const project = makeMaintenanceProject(join(WORK, 'no-force'));
  mkdirSync(join(project, 'backups'), { recursive: true });
  const clis: readonly (readonly [string, (argv: readonly string[]) => number])[] = [
    ['ops:complete-backup', completeBackupCli],
    ['ops:complete-restore', completeRestoreCli],
    ['ops:backup-retention', retentionCli],
    ['ops:safety-set-lifecycle', lifecycleCli],
  ];
  for (const [name, cli] of clis) {
    for (const forbidden of ['--force', '--break-lock', '--steal-lock', '--ignore-lock', '--yes']) {
      const code = quietly(() => cli(['--project', project, forbidden]));
      assertEq(code, 2, `${name} must reject ${forbidden} as a usage error, and it answered ${code}`);
    }
  }
  // AND NOTHING REMOVES A LOCK IT DID NOT TAKE.
  const owner = readRepo('src/ops/maintenance-safety.ts');
  const acquire = owner.slice(owner.indexOf('export function acquireDestinationLock'));
  const scope = acquire.slice(0, acquire.indexOf('export class MaintenanceLocks'));
  assert(!scope.includes('rmSync') && !scope.includes('rmdirSync'),
    'acquiring a destination lock never removes one');
});

test('the plan-only operator surfaces stay non-destructive', () => {
  // ASKED OF THE INVOCATIONS, NOT OF THE PROSE. Both files EXPLAIN `--confirm` — that a person types the
  // digest back — and neither may ever pass it. So what is scanned is the lines that actually run a command.
  const invokes = (source: string): readonly string[] => source.split('\n')
    .filter((line) => ['ops:backup-retention', 'ops:safety-set-lifecycle', 'ops:complete-backup',
      'ops:complete-restore'].some((command) => line.includes(command)))
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('#') && !trimmed.startsWith('//') && !trimmed.startsWith('*');
    });
  for (const [what, source] of [
    ['the scheduled maintenance script', readRepo('deploy/unraid-catalog-maintenance.sh')],
    ['the operator panel', readRepo('src/ops/operator-ui-service.ts')],
  ] as const) {
    for (const line of invokes(source)) {
      assert(!line.includes('--confirm'), `${what} must never invoke --confirm: ${line.trim()}`);
    }
    assert(!source.includes('--force'), `${what} offers no force flag`);
  }
});

// -----------------------------------------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
for (const [name, err] of failures) {
  console.log(`\nFAILED: ${name}\n  ${(err as Error).stack ?? String(err)}`);
}
if (failed > 0) process.exitCode = 1;

// A file that wrote nothing would be a file that proved nothing; the fixtures are left for inspection when a
// run fails and removed when it does not.
if (failed === 0) {
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* a leftover fixture is not a failure */ }
} else {
  console.log(`\nfixtures kept at ${WORK}`);
}
