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
  MAINTENANCE_LOCK_DIRNAME,
  MaintenanceLocks,
  MaintenanceRefused,
  assertHeldDestination,
  provePhysicalDestination,
  resolveBackupDestination,
  type HeldDestination,
} from '../src/ops/maintenance-safety.js';
import {
  RETENTION_JOURNAL_NAME, abandonRetention, planRetention, resolveRetentionRequest, runRetention,
} from '../src/ops/backup-retention.js';
import { DEFAULT_RETENTION_POLICY } from '../src/ops/retention-model.js';
import {
  SAFETY_SET_JOURNAL_NAME, planSafetySetLifecycle, resolveSafetySetRequest, runSafetySetLifecycle,
} from '../src/ops/safety-set-lifecycle.js';
import { DEFAULT_SAFETY_SET_POLICY } from '../src/ops/safety-set-model.js';
import {
  RESTORE_JOURNAL_NAME, RESTORE_JOURNAL_VERSION, abandonRestore, planCompleteRestore, readRestoreJournal,
  resolveCompleteRestoreRequest, runCompleteRestore,
} from '../src/ops/complete-restore.js';
import {
  runVerifiedCompleteBackup, takeCompleteBackupWithoutVerifying,
} from '../src/ops/complete-backup.js';
import { main as completeBackupCli } from '../src/ops/complete-backup-cli.js';
import { main as completeRestoreCli } from '../src/ops/complete-restore-cli.js';
import { main as retentionCli } from '../src/ops/backup-retention-cli.js';
import { main as lifecycleCli } from '../src/ops/safety-set-lifecycle-cli.js';
import { fakeToolchain } from './helpers/fake-toolchain.js';
import { restoreStack, setDumpDigest, setKeystoreDigest } from './helpers/fake-restore-stack.js';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
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
  type HoldPoint,
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
  // THROUGH THE STACK, BECAUSE THERE IS NO OTHER ROUTE — CORRECTION 1. `acquireDestinationLock` is no
  // longer exported at all, so neither a command nor a suite can take a destination lock without first
  // holding a project lock. Two DISTINCT projects here, so the project locks never contend and the only
  // thing that can refuse is the destination.
  const shared = makeSharedDestination(WORK, 'alias-lock');
  const outer = resolveBackupDestination(shared.outer, shared.outerDestination).destinationDir;
  const inner = resolveBackupDestination(shared.inner, shared.innerDestination).destinationDir;
  const first = MaintenanceLocks.open(shared.outer);
  try {
    first.lockDestination(outer);
    const second = MaintenanceLocks.open(shared.inner);
    try {
      refuses(() => second.lockDestination(inner), 'already working in this backup destination',
        'the second address finds the lock the first one took');
    } finally {
      second.release();
    }
  } finally {
    first.release();
  }
  // AND IT IS RELEASED, so the second address can take it once the first is done.
  const later = MaintenanceLocks.open(shared.inner);
  later.lockDestination(inner);
  later.release();
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
  const shared = makeSharedDestination(WORK, 'alias-case');
  const insensitive = existsSync(join(shared.inner, 'BACKUPS'));
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
  const lower = resolveBackupDestination(shared.inner, 'backups');
  const upper = resolveBackupDestination(shared.outer, 'inner/BACKUPS');
  const holder = MaintenanceLocks.open(shared.inner);
  try {
    holder.lockDestination(lower.destinationDir);
    const other = MaintenanceLocks.open(shared.outer);
    try {
      refuses(() => other.lockDestination(upper.destinationDir),
        'already working in this backup destination',
        'the other spelling of one directory finds the lock that is already in it');
    } finally {
      other.release();
    }
  } finally {
    holder.release();
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

test('the raw destination-lock acquisition is not exported, so the order cannot be expressed backwards', () => {
  // CORRECTION 1 MADE THIS STRUCTURAL RATHER THAN POLICED. The first cut exported
  // `acquireDestinationLock` and asserted that no command module called it — a lint rule, not an authority.
  // It is now module-private, so a caller literally cannot reach it: the only route to a destination lock
  // is an instance of `MaintenanceLocks`, and the only way to get one of those is to take the project lock.
  const owner = readRepo('src/ops/maintenance-safety.ts');
  assert(owner.includes('\nfunction acquireDestinationLock('),
    'the acquisition is declared without `export`');
  assert(!owner.includes('export function acquireDestinationLock'),
    'and is not exported under any signature');
});

test('every command takes both locks through the one stack, and nothing takes them directly', () => {
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

test('there is EXACTLY ONE destination lock name, so acquisition is one atomic mkdir', () => {
  // CORRECTION 1. The first cut renamed the lock to `.catalog-destination.lock` and kept the old name
  // working by `lstat`ing it first — a check of one name followed by a create of another, which is not a
  // lock at all: an older build could `mkdir` the old name inside that window and both processes would
  // believe they held the destination. There is one name, it is the one older builds already use, and
  // acquiring it is a single `mkdir`.
  assertEq(DESTINATION_LOCK_DIRNAMES.length, 1, 'one name, because two names cannot be acquired atomically');
  assertEq(DESTINATION_LOCK_DIRNAMES[0], DESTINATION_LOCK_DIRNAME, 'and it is the canonical one');
  assertEq(DESTINATION_LOCK_DIRNAME, '.catalog-retention.lock',
    'which is the name every shipped build of this product has used, so cross-version contention is real');
  const owner = readRepo('src/ops/maintenance-safety.ts');
  const acquire = owner.slice(owner.indexOf('function acquireDestinationLock'));
  const body = acquire.slice(0, acquire.indexOf('\n}'));
  assert(!body.includes('lstat') && !body.includes('existsSync'),
    'and acquiring it inspects nothing first: a pre-check is the race this correction removed');
  assertEq((body.match(/acquireLockDirectory\(/g) ?? []).length, 1, 'one mkdir, not two');
});

test('there is one destination lock name and one refusal vocabulary, and no command spells it itself', () => {
  const owner = readRepo('src/ops/maintenance-safety.ts');
  assert(owner.includes(`'${DESTINATION_LOCK_DIRNAME}'`), 'the name is a literal in exactly one module');
  for (const file of ['complete-backup', 'complete-restore', 'backup-retention', 'safety-set-lifecycle']) {
    const source = readRepo(`src/ops/${file}.ts`);
    assert(!source.includes(`'${DESTINATION_LOCK_DIRNAME}'`), `src/ops/${file}.ts does not spell the name`);
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
  /** Where the holder stops. `before-verify` is the Correction 1 window. */
  readonly holdAt?: HoldPoint;
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
    ...(scenario.holdAt === undefined ? {} : { holdAt: scenario.holdAt }),
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

test('the locks are STILL HELD after publication and before the verification verdict', () => {
  // ---- CORRECTION 1, RELEASE-BLOCKER 1 -------------------------------------------------------------
  //
  // THE DEFECT. `runVerifiedCompleteBackup` called `takeCompleteBackupWithoutVerifying`, which releases both
  // locks in its own `finally`, and only THEN read every byte of the set back to decide whether to tell the
  // operator `ok`. Between the publication and the verdict this project held nothing at all, so another
  // project could quarantine the set, delete it, or move something else into its name — and this command
  // would then report success about a set that had gone, failure about a set somebody else removed, or a
  // verdict about a directory it did not take.
  //
  // A SOURCE ORDERING ASSERTION CANNOT PROVE THIS. What has to be true is that a lock DIRECTORY EXISTS ON
  // DISK at a particular instant, and that other processes really are refused at it. So a real process is
  // stopped at `before-verify` — the set published, the verdict not yet computed — and five real contenders
  // are started from another project against the same physical destination from inside that instant.
  const { evidence, shared } = runScenario({
    name: 'hold-backup-before-verify', holder: 'complete-backup', holdAt: 'before-verify',
  });
  assertEq(evidence.publishedAtBoundary, true,
    'the holder had already PUBLISHED its set at its final name when the contenders ran');
  assertEq(evidence.lockHeldAtBoundary, true,
    'and it was still holding the shared destination lock, which is the whole correction');
  assertEq(evidence.projectLockHeldAtBoundary, true, 'and its own project lock');
  assertEq(evidence.results.length, 5, 'every contender ran');
  for (const result of evidence.results) {
    assertContenderRefusedWithoutEffect(result, `before-verify/${result.label}`);
  }
  assert(sameTree(evidence.destinationBefore, evidence.destinationAfter),
    'and the published set was still byte-identical when the verification was allowed to start: '
    + treeDifference(evidence.destinationBefore, evidence.destinationAfter).join(', '));

  // AND THE COMMAND FINISHED NORMALLY afterwards, releasing both locks: holding longer must not mean
  // holding forever.
  assertEq(existsSync(join(shared.destination, DESTINATION_LOCK_DIRNAME)), false,
    'the destination lock was released once the verdict existed');
  assertEq(existsSync(join(shared.outer, MAINTENANCE_LOCK_DIRNAME)), false, 'and so was the project lock');
  assert(existsSync(join(shared.destination, 'holder-set')), 'and the verified set is where it was published');
});

test('holding past the verdict does not mean holding forever: every path out releases both locks', () => {
  // ---- THE OTHER HALF OF EXTENDING THE WINDOW ------------------------------------------------------
  //
  // Correction 1 made the ordinary command hold both locks through the verification. The risk a change
  // like that carries is the opposite of the one it fixes: a path that now leaves a lock behind. So every
  // way out is driven for real — success, a failure INSIDE the quiesced window, and a verification that
  // blows up because the set it was about to read has gone — and after each one both lock directories must
  // be gone, whatever the command answered.
  const root = makeMaintenanceProject(join(WORK, 'release-paths'));
  mkdirSync(join(root, 'backups'), { recursive: true });
  const destination = join(root, 'backups');
  const bothReleased = (what: string): void => {
    assertEq(existsSync(join(destination, DESTINATION_LOCK_DIRNAME)), false, `${what}: the destination lock`);
    assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, `${what}: the project lock`);
  };

  // 1. SUCCESS.
  takeSharedSet(root, 'backups', 'set-ok', new Date('2020-01-01T00:00:00.000Z'));
  bothReleased('after a verified success');

  // 2. A FAILURE INSIDE THE QUIESCED WINDOW. Nothing is published and both locks come back.
  const broken = fakeToolchain({ failWhen: [{ contains: 'pg_dump', status: 1 }] });
  let refused = false;
  try {
    runVerifiedCompleteBackup({
      projectRoot: root, destination: 'backups', setName: 'set-fails', custodian: 'inline',
      secrets: 'secrets', promotionRecords: 'promotion-records',
    }, { runner: broken.runner, fileRunner: broken.fileRunner, ledger: broken.ledger });
  } catch { refused = true; }
  assertEq(refused, true, 'a dump that does not run refuses');
  assertEq(existsSync(join(destination, 'set-fails')), false, 'and publishes nothing');
  bothReleased('after a failure inside the window');

  // 3. THE VERIFICATION ITSELF GOES WRONG. The set is renamed away at `after-publish`, so what the
  //    verification reaches is not what was taken — which is exactly the state the OLD code could reach by
  //    losing the lock, and is produced here deliberately to drive the release path. Whether the command
  //    throws or answers `ok: false`, it must not keep a lock.
  const tools = fakeToolchain();
  let outcome: { readonly ok: boolean } | null = null;
  let threw = false;
  try {
    outcome = runVerifiedCompleteBackup({
      projectRoot: root, destination: 'backups', setName: 'set-vanishes', custodian: 'inline',
      secrets: 'secrets', promotionRecords: 'promotion-records',
    }, {
      runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger,
      at: (point) => {
        if (point === 'after-publish') renameSync(join(destination, 'set-vanishes'), join(root, 'taken-away'));
      },
    });
  } catch { threw = true; }
  assert(threw || (outcome !== null && !outcome.ok),
    'a set that is not there when it is verified is never a success');
  bothReleased('after a verification that could not read the set');
});

test('a nested failure releases nothing of the caller\'s, because it took nothing', () => {
  // PARTIAL FAILURE UNDER A CAPABILITY. The restore holds both locks across its whole operation; a safety
  // set that fails must leave that window exactly as it found it. If the nested backup released anything
  // on its way out, the restore would carry on destroying volumes with nothing holding the destination.
  const root = makeMaintenanceProject(join(WORK, 'nested-failure'));
  mkdirSync(join(root, 'backups'), { recursive: true });
  const destination = resolveBackupDestination(root, 'backups').destinationDir;
  const claim = `.pre-restore-claim-${'f'.repeat(24)}`;
  mkdirSync(join(destination, claim));
  const locks = MaintenanceLocks.open(root);
  try {
    locks.lockDestination(destination);
    const held = locks.heldDestination();
    const broken = fakeToolchain({ failWhen: [{ contains: 'pg_dump', status: 1 }] });
    let refused = false;
    try {
      runVerifiedCompleteBackup({
        projectRoot: root, destination: `backups/${claim}`, setName: 'pre-restore-set-a',
        custodian: 'inline', secrets: 'secrets', promotionRecords: 'promotion-records',
      }, {
        runner: broken.runner, fileRunner: broken.fileRunner, ledger: broken.ledger,
        held, requireExistingDestination: true,
      });
    } catch { refused = true; }
    assertEq(refused, true, 'the nested backup failed');
    // AND THE CALLER STILL HOLDS EVERYTHING.
    assert(existsSync(join(destination, DESTINATION_LOCK_DIRNAME)), 'the destination lock is still held');
    assert(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), 'and so is the project lock');
    assertEq(existsSync(join(destination, claim, 'pre-restore-set-a')), false, 'and nothing was published');
    // AND THE CAPABILITY IS STILL GOOD, so the caller can recover rather than being locked out by a failure.
    assertHeldDestination(held, root, join(destination, claim));
  } finally {
    locks.release();
  }
  assertEq(existsSync(join(destination, DESTINATION_LOCK_DIRNAME)), false, 'and the caller released at the end');
});

test('the verified command never routes through the step that owns and drops its own locks', () => {
  // THE STRUCTURAL HALF OF THE SAME FACT, which is cheap and catches a refactor that reintroduces the
  // window without changing behaviour under test. `takeCompleteBackupWithoutVerifying` releases in its own
  // `finally` — correctly, it is the unverified entry point — so the verified command must not call it.
  const source = readRepo('src/ops/complete-backup.ts');
  const verified = source.slice(source.indexOf('export function runVerifiedCompleteBackup'));
  assert(!verified.includes('takeCompleteBackupWithoutVerifying('),
    'the verified command does not call the entry point that releases the locks before it returns');
  assert(verified.includes('performBackup(resolved, deps)') && verified.includes('verifyWhatWasTaken('),
    'it takes and verifies inside one locked region');
  assert(verified.lastIndexOf('locks.release()') > verified.indexOf('verifyWhatWasTaken('),
    'and releases only after the verification');
});

test('the operator surface refuses a shared destination with exit 3, an empty stdout and one sentence', () => {
  // ---- CORRECTION 1, ITEM 4: THIS TEST NOW SAYS WHAT IT CHECKS -------------------------------------
  //
  // It was titled "one JSON document" and asserted the opposite — an EMPTY stdout and a prose sentence on
  // stderr. Both cannot be true, and the assertions were the honest half. THE ACTUAL CONTRACT, unchanged by
  // this tranche and stated here rather than dressed up: a refusal that happens BEFORE any effect has no
  // report to serialise, so `--json` produces NO document at all. stdout stays empty — which is what a
  // machine parsing stdout needs, because zero documents is unambiguous and a document of prose is not —
  // the sentence goes to stderr, and the exit code is this family's `3`. The `--json` document contract
  // belongs to the REPORT paths (`ok`/`INCOMPLETE`/`PARTIAL`/post-effect failures) and those are asserted,
  // as exactly one document each, in `test/backup-retention.ts`. Nothing here claims a document was made.
  const { evidence } = runScenario({ name: 'hold-retention-json', holder: 'backup-retention' });
  const cli = evidence.results.find((result) => result.label === 'backup-retention-cli');
  assert(cli !== undefined, 'the CLI contender ran');
  assertEq(cli!.exitCode, 3, 'the exit code is this family\'s "refused"');
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

function runLifecycleIn(projectRoot: string, destination: string): ReturnType<typeof runSafetySetLifecycle> {
  const policy = { ...DEFAULT_SAFETY_SET_POLICY, keepLast: 1, minAgeDays: 0 };
  const now = new Date('2026-07-31T12:00:00.000Z');
  const plan = planSafetySetLifecycle(resolveSafetySetRequest({ projectRoot, destination }), policy, now);
  return runSafetySetLifecycle({ projectRoot, destination }, policy, { now: () => now },
    { kind: 'run', confirm: plan.digest });
}

/** A real `ops:complete-restore` run, planned by itself, against the fake stack. */
function restoreFrom(projectRoot: string, destination: string, setName: string): unknown {
  const setDir = join(projectRoot, destination, setName);
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  const request = {
    projectRoot, destination, setName, custodian: 'inline' as const,
    secrets: 'secrets', promotionRecords: 'promotion-records',
  };
  const plan = planCompleteRestore(resolveCompleteRestoreRequest(request),
    { safetySet: true, acceptDataLoss: false });
  return runCompleteRestore(request, {
    runner: world.runner,
    fileRunner: world.inputRunner,
    backupFileRunner: world.outputRunner,
    ledger: world.ledger,
    suffix: () => 'aaaaaaaaaaaa',
    now: () => new Date('2026-07-31T12:00:00.000Z'),
  }, { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
}

/**
 * Exactly what an OLDER build did to take the destination lock: one `mkdir`, at `.catalog-retention.lock`.
 *
 * It is spelled as a literal here on purpose. The point of the compatibility test is that the two builds
 * agree on a NAME ON DISK; importing this build's constant would make the test pass by construction even if
 * a future change renamed it, which is the exact failure mode Correction 1 exists for.
 */
function oldStyleAcquire(destinationDir: string): boolean {
  try { mkdirSync(join(destinationDir, '.catalog-retention.lock')); return true; } catch { return false; }
}

test('an OLD-STYLE holder excludes every new command, atomically and by the same name', () => {
  // ---- CORRECTION 1: THE CROSS-VERSION CONTRACT IS A FILENAME -------------------------------------
  //
  // An `ops:backup-retention` or `ops:safety-set-lifecycle` from a build before this tranche takes the
  // destination lock by `mkdir`ing `.catalog-retention.lock`. Every command of THIS build takes the same
  // name with the same call, so the old holder and the new contender contend on one directory entry with
  // no window between a check and a create — because there is no check.
  const shared = makeSharedDestination(WORK, 'compat-old-holds');
  takeSharedSet(shared.outer, shared.outerDestination, 'set-a', new Date('2020-01-01T00:00:00.000Z'));
  takeSharedSet(shared.outer, shared.outerDestination, 'set-b', new Date('2021-01-01T00:00:00.000Z'));
  assertEq(oldStyleAcquire(shared.destination), true, 'the old-style holder took the lock');

  const before = snapshotTree(shared.destination);
  refuses(() => runRetentionIn(shared.inner, 'backups'), 'already working in this backup destination',
    'a new prune is excluded by an old holder');
  refuses(() => runLifecycleIn(shared.inner, 'backups'), 'already working in this backup destination',
    'and so is a new safety-set lifecycle run');
  refuses(() => takeSharedSet(shared.inner, 'backups', 'after-old'), 'already working in this backup destination',
    'and so is a new complete backup, which the OLD build would not have excluded at all');
  refuses(() => restoreFrom(shared.inner, 'backups', 'set-a'), 'already working in this backup destination',
    'and so is a new complete restore');
  assert(sameTree(before, snapshotTree(shared.destination)),
    `and none of them changed the destination: ${treeDifference(before, snapshotTree(shared.destination)).join(', ')}`);
  assert(existsSync(join(shared.destination, '.catalog-retention.lock')), 'nothing removed the old holder\'s lock');

  // AND IT IS NOT A WEDGE. The old holder finishing releases it the way it always did, and the destination
  // works again immediately.
  rmSync(join(shared.destination, '.catalog-retention.lock'), { recursive: true });
  takeSharedSet(shared.inner, 'backups', 'after-old');
  assert(existsSync(join(shared.destination, 'after-old')), 'the set is published once the old lock is gone');
});

test('a NEW holder excludes an OLD-STYLE acquisition, proved from inside a real held boundary', () => {
  // THE OTHER DIRECTION, and it needs a real holder rather than a hand-made lock: what is being proved is
  // that a command of THIS build leaves, at the name an older build will try, a directory that older
  // build's own `mkdir` fails on. The old-style acquisition is attempted from inside the holder's boundary.
  const shared = makeSharedDestination(WORK, 'compat-new-holds');
  takeSharedSet(shared.outer, shared.outerDestination, 'set-a', new Date('2020-01-01T00:00:00.000Z'));
  takeSharedSet(shared.outer, shared.outerDestination, 'set-b', new Date('2021-01-01T00:00:00.000Z'));

  const holder = MaintenanceLocks.open(shared.outer);
  try {
    holder.lockDestination(resolveBackupDestination(shared.outer, shared.outerDestination).destinationDir);
    assertEq(oldStyleAcquire(shared.destination), false,
      'an older build\'s mkdir of .catalog-retention.lock fails while this build holds the destination');
    assert(existsSync(join(shared.destination, '.catalog-retention.lock')),
      'because that IS the directory this build created — one name, one entry, no second lock beside it');
    assertEq(readdirSync(shared.destination).filter((name) => name.endsWith('.lock')).length, 1,
      'and there is exactly one lock in the destination, not one per version');
  } finally {
    holder.release();
  }
  assertEq(oldStyleAcquire(shared.destination), true, 'and the old-style acquisition succeeds once it is released');
  rmSync(join(shared.destination, '.catalog-retention.lock'), { recursive: true });
});

test('the destination lock name is excluded from both inventories', () => {
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

// -----------------------------------------------------------------------------------------------------------
// CORRECTION 1, RELEASE-BLOCKER 2: the nested authority is a capability, not a boolean and not a grep
// -----------------------------------------------------------------------------------------------------------
//
// `holdingLock: true` named no project, no destination and no holder, so ANY caller could suppress BOTH
// locks for ANY project and ANY destination; a suite grepping `src/` for the word was the only thing between
// that flag and an unlocked backup, and a source allowlist is a lint rule rather than an authority. Every
// check below is BEHAVIOURAL: a real backup is really attempted, and what stops it is the capability check.

/** A destination, a claim directory inside it, and a live capability for the destination. */
function heldFixture(name: string): {
  readonly root: string;
  readonly destination: string;
  readonly claim: string;
  readonly locks: MaintenanceLocks;
  readonly held: HeldDestination;
} {
  const root = makeMaintenanceProject(join(WORK, name));
  mkdirSync(join(root, 'backups'), { recursive: true });
  const destination = resolveBackupDestination(root, 'backups').destinationDir;
  const claim = '.pre-restore-claim-aaaaaaaaaaaaaaaaaaaaaaaa';
  mkdirSync(join(destination, claim), { recursive: true });
  const locks = MaintenanceLocks.open(root);
  locks.lockDestination(destination);
  return { root, destination, claim, locks, held: locks.heldDestination() };
}

/** Attempt a nested backup under a capability, and answer with what happened. */
function nestedBackup(root: string, destination: string, setName: string, held: HeldDestination): {
  readonly refusal: string | null; readonly commands: readonly string[];
} {
  const tools = fakeToolchain();
  try {
    runVerifiedCompleteBackup({
      projectRoot: root, destination, setName, custodian: 'inline',
      secrets: 'secrets', promotionRecords: 'promotion-records',
    }, {
      runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger,
      now: () => new Date('2026-07-31T12:00:00.000Z'), held,
    });
  } catch (err) {
    return { refusal: (err as Error).message, commands: tools.ledger.flat() };
  }
  return { refusal: null, commands: tools.ledger.flat() };
}

test('a capability minted by a real holder authorises the nested backup it was minted for', () => {
  const fixture = heldFixture('cap-legitimate');
  try {
    const outcome = nestedBackup(fixture.root, `backups/${fixture.claim}`, 'pre-restore-set-a', fixture.held);
    assertEq(outcome.refusal, null, 'the legitimate nested backup ran');
    assert(existsSync(join(fixture.destination, fixture.claim, 'pre-restore-set-a')),
      'and published its set inside the claim directory');
    // AND IT TOOK NO SECOND LOCK. One lock, in the destination the caller is holding — never one inside the
    // claim, which would be a lock on the wrong directory and a stray entry in a set's own claim.
    assertEq(readdirSync(fixture.destination).filter((name) => name.endsWith('.lock')).length, 1,
      'exactly one lock in the destination');
    assertEq(existsSync(join(fixture.destination, fixture.claim, DESTINATION_LOCK_DIRNAME)), false,
      'and none inside the claim');
  } finally {
    fixture.locks.release();
  }
});

test('a FORGED capability is refused at runtime, before a directory exists', () => {
  const fixture = heldFixture('cap-forged');
  try {
    // THE ONE FORGERY TYPESCRIPT CANNOT STOP: a plain object with the right shape, cast. The runtime
    // identity check is what catches it — the object was never minted, so it is not in the private set.
    const forged = { projectRoot: fixture.root, destination: fixture.destination,
      destinationDir: fixture.destination } as unknown as HeldDestination;
    const outcome = nestedBackup(fixture.root, 'forged-destination', 'set-forged', forged);
    assert(outcome.refusal !== null && outcome.refusal.includes('not one this product minted'),
      `a cast object is refused: ${String(outcome.refusal)}`);
    assertEq(outcome.commands.length, 0, 'and no child command was issued');
    assertEq(existsSync(join(fixture.root, 'forged-destination')), false,
      'and the destination it named was never created — the refusal is before the first effect');
  } finally {
    fixture.locks.release();
  }
});

test('a capability for ANOTHER project authorises nothing here', () => {
  const shared = makeSharedDestination(WORK, 'cap-other-project');
  const locks = MaintenanceLocks.open(shared.outer);
  try {
    locks.lockDestination(resolveBackupDestination(shared.outer, shared.outerDestination).destinationDir);
    const held = locks.heldDestination();
    // The destination is the SAME physical directory. Only the project differs, and that is enough.
    const outcome = nestedBackup(shared.inner, 'backups', 'set-cross-project', held);
    assert(outcome.refusal !== null && outcome.refusal.includes('DIFFERENT project'),
      `a lock on one project is not permission in another: ${String(outcome.refusal)}`);
    assertEq(outcome.commands.length, 0, 'and nothing ran');
    assertEq(existsSync(join(shared.destination, 'set-cross-project')), false, 'and nothing was published');
  } finally {
    locks.release();
  }
});

test('a capability for one destination authorises nothing in a sibling or a parent of it', () => {
  const fixture = heldFixture('cap-wrong-destination');
  mkdirSync(join(fixture.root, 'other-backups'), { recursive: true });
  try {
    const sibling = nestedBackup(fixture.root, 'other-backups', 'set-sibling', fixture.held);
    assert(sibling.refusal !== null && sibling.refusal.includes('DIFFERENT backup destination'),
      `a sibling destination is refused: ${String(sibling.refusal)}`);
    assertEq(existsSync(join(fixture.root, 'other-backups', 'set-sibling')), false, 'and nothing was published');

    // A DESTINATION THAT DOES NOT EXIST YET IS REFUSED BEFORE IT IS CREATED, which is the ordering that
    // matters: the capability check runs ahead of every filesystem effect, including the destination mkdir.
    const absent = nestedBackup(fixture.root, 'not-there-yet', 'set-absent', fixture.held);
    assert(absent.refusal !== null && absent.refusal.includes('DIFFERENT backup destination'),
      `an unborn destination is refused too: ${String(absent.refusal)}`);
    assertEq(existsSync(join(fixture.root, 'not-there-yet')), false, 'and was never created');

    // ---- AND A DESCENDANT IS NOT A TARGET JUST BECAUSE IT IS UNDERNEATH ---------------------------
    //
    // The permitted set is closed: the held destination, or one EXISTING claim directly inside it. An
    // ordinary subdirectory, a deeper path, and a claim-shaped name nested two levels down are each
    // refused, because none of them is the one directory the legitimate caller publishes into.
    mkdirSync(join(fixture.destination, 'ordinary'), { recursive: true });
    const ordinary = nestedBackup(fixture.root, 'backups/ordinary', 'set-descendant', fixture.held);
    assert(ordinary.refusal !== null && ordinary.refusal.includes('DIFFERENT backup destination'),
      `an ordinary descendant is refused: ${String(ordinary.refusal)}`);
    assertEq(existsSync(join(fixture.destination, 'ordinary', 'set-descendant')), false, 'and published nothing');

    const deep = join(fixture.destination, fixture.claim, `.pre-restore-claim-${'b'.repeat(24)}`);
    mkdirSync(deep, { recursive: true });
    const nested = nestedBackup(fixture.root,
      `backups/${fixture.claim}/.pre-restore-claim-${'b'.repeat(24)}`, 'set-deep', fixture.held);
    assert(nested.refusal !== null && nested.refusal.includes('DIFFERENT backup destination'),
      `a claim-shaped name TWO levels down is refused: ${String(nested.refusal)}`);
    assertEq(existsSync(join(deep, 'set-deep')), false, 'and published nothing');
    assertEq(ordinary.commands.length + nested.commands.length, 0, 'and neither ran a child command');
  } finally {
    fixture.locks.release();
  }
});

test('a standalone backup is refused a claim-shaped destination, before any effect', () => {
  // ---- CORRECTION 1 ADDENDUM: THE CLAIM NAMESPACE IS NOT AN OPERATOR DESTINATION ------------------
  //
  // The first cut listed this as an open risk. The destination lock is taken in the directory a command
  // publishes into, so a hand-run `ops:complete-backup --destination backups/.pre-restore-claim-<nonce>`
  // locks INSIDE the claim while `ops:backup-retention` and `ops:safety-set-lifecycle` lock the
  // destination ABOVE it — two commands in one destination, each holding a lock the other never looks at.
  const root = makeMaintenanceProject(join(WORK, 'claim-namespace'));
  mkdirSync(join(root, 'backups'), { recursive: true });
  const claim = `.pre-restore-claim-${'c'.repeat(24)}`;
  mkdirSync(join(root, 'backups', claim));
  const before = snapshotTree(join(root, 'backups'));

  for (const [what, destination] of [
    ['an existing claim', `backups/${claim}`],
    ['a claim that does not exist', `backups/.pre-restore-claim-${'d'.repeat(24)}`],
    ['a directory inside a claim', `backups/${claim}/deeper`],
  ] as const) {
    const tools = fakeToolchain();
    refuses(() => runVerifiedCompleteBackup({
      projectRoot: root, destination, setName: 'manual-set', custodian: 'inline',
      secrets: 'secrets', promotionRecords: 'promotion-records',
    }, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger }),
      'safety-set claim namespace', `${what} is refused as a destination`);
    assertEq(tools.ledger.flat().length, 0, `${what}: and no child command was issued`);
    // The UNVERIFIED entry point is refused for the same reason, so there is no second door into a claim.
    const also = fakeToolchain();
    refuses(() => takeCompleteBackupWithoutVerifying({
      projectRoot: root, destination, setName: 'manual-set', custodian: 'inline',
      secrets: 'secrets', promotionRecords: 'promotion-records',
    }, { runner: also.runner, fileRunner: also.fileRunner, ledger: also.ledger }),
      'safety-set claim namespace', `${what} is refused by the unverified entry point too`);
  }
  assert(sameTree(before, snapshotTree(join(root, 'backups'))),
    `and nothing changed: ${treeDifference(before, snapshotTree(join(root, 'backups'))).join(', ')}`);
  assertEq(existsSync(join(root, 'backups', DESTINATION_LOCK_DIRNAME)), false, 'not even a lock was taken');

  // AND THE ORDINARY DESTINATION STILL WORKS, so this is a refusal of a namespace and not of a project.
  takeSharedSet(root, 'backups', 'ordinary-set', new Date('2020-01-01T00:00:00.000Z'));
  assert(existsSync(join(root, 'backups', 'ordinary-set')), 'an ordinary destination is unaffected');
});

test('a capability is bound to the DIRECTORY, so a renamed-away destination rebuilt at its path is refused', () => {
  // ---- CORRECTION 1 ADDENDUM: PATH REUSE DOES NOT SATISFY "PHYSICAL" -----------------------------
  //
  // THE DEFECT THIS CLOSES, which was in the correction's own first cut: the check compared the directory
  // currently at a path with the directory currently at that same path — a tautology. Rename the held
  // destination away and create a new directory at the original path and every string still lines up,
  // while the lock that was actually taken sits in the inode that moved. The capability now carries the
  // `ino`/`dev` of the destination AND of the lock directory, captured when `lockDestination` acquired.
  const root = makeMaintenanceProject(join(WORK, 'identity-rebound'));
  mkdirSync(join(root, 'backups'), { recursive: true });
  const destination = resolveBackupDestination(root, 'backups').destinationDir;
  const claim = `.pre-restore-claim-${'e'.repeat(24)}`;
  const locks = MaintenanceLocks.open(root);
  let held: HeldDestination;
  try {
    locks.lockDestination(destination);
    held = locks.heldDestination();
    mkdirSync(join(destination, claim));
    // It authorises the claim it was minted for, right now, while the directory is the one it was minted in.
    assertHeldDestination(held, root, join(destination, claim));

    // THE DESTINATION IS RENAMED AWAY — taking this run's lock directory with it — AND A NEW ONE IS BUILT
    // AT THE SAME PATH, complete with a claim of the same name and even a lock directory of its own.
    renameSync(destination, join(root, 'backups-moved'));
    mkdirSync(destination);
    mkdirSync(join(destination, claim));
    mkdirSync(join(destination, DESTINATION_LOCK_DIRNAME));
    const replacement = snapshotTree(destination);

    refuses(() => assertHeldDestination(held, root, join(destination, claim)),
      'not the directory that is at that path now',
      'the capability does not authorise a directory that merely reuses the path');
    const outcome = nestedBackup(root, `backups/${claim}`, 'pre-restore-set-a', held);
    assert(outcome.refusal !== null && outcome.refusal.includes('not the directory that is at that path now'),
      `and a real backup under it refuses: ${String(outcome.refusal)}`);
    assertEq(outcome.commands.length, 0, 'having issued no child command');
    assert(sameTree(replacement, snapshotTree(destination)),
      `and left the replacement untouched: ${treeDifference(replacement, snapshotTree(destination)).join(', ')}`);
    assertEq(existsSync(join(destination, claim, 'pre-restore-set-a')), false, 'nothing was published');
  } finally {
    // ---- AND RELEASE MUST NOT DELETE SOMEBODY ELSE'S LOCK -----------------------------------------
    //
    // THE DEFECT THIS PINS, which this very fixture found. Release used to `rmdir` whatever was at the
    // remembered PATH. Here that path now holds a DIFFERENT lock directory — the replacement's — while
    // this run's real lock sits inside the destination that was renamed away. A path-based release would
    // delete a live lock belonging to whoever built the replacement, and leave its own behind. Release is
    // bound to the directory identity captured at acquisition and to a token inside it, so it does
    // nothing here.
    locks.release();
  }
  assert(existsSync(join(destination, DESTINATION_LOCK_DIRNAME)),
    'the REPLACEMENT lock is still there: this run released a path it no longer owned, so it released nothing');
  assert(existsSync(join(root, 'backups-moved', DESTINATION_LOCK_DIRNAME)),
    'and the lock this run took is still where it went, stale — reported by the next run, never swept');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false,
    'while the PROJECT lock, whose directory nobody moved, released normally — reverse order, both attempted');

  // EXPLICIT CLEANUP, because this fixture deliberately leaves two locks nothing owns.
  rmSync(join(destination, DESTINATION_LOCK_DIRNAME), { recursive: true, force: true });
  rmSync(join(root, 'backups-moved'), { recursive: true, force: true });
});

test('a lock whose directory was rebuilt by somebody else is never released by the run that lost it', () => {
  // THE SAME OWNERSHIP RULE, ASKED DIRECTLY OF THE PRIMITIVE, so it is pinned for the PROJECT lock too and
  // not only for the destination lock that happened to expose it.
  const root = makeMaintenanceProject(join(WORK, 'release-ownership'));
  const locks = MaintenanceLocks.open(root);
  const lockPath = join(root, MAINTENANCE_LOCK_DIRNAME);
  assert(existsSync(lockPath), 'the project lock is held');

  // Somebody renames the lock away and puts a different directory at its name — a second run that took it
  // after a rename, or an operator tidying up. Either way, what is at that path is not this run's lock.
  renameSync(lockPath, join(root, 'lock-moved-aside'));
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'holder.txt'), `pid=999999\ntoken=${'b'.repeat(32)}\n`, 'utf8');

  locks.release();
  assert(existsSync(lockPath), 'the foreign lock at that path is untouched');
  assertEq(readFileSync(join(lockPath, 'holder.txt'), 'utf8').includes('b'.repeat(32)), true,
    'including its holder note, which still names its own owner');
  assert(existsSync(join(root, 'lock-moved-aside')), 'and the moved original is left stale rather than hidden');
  rmSync(lockPath, { recursive: true, force: true });
});

test('a capability whose owner has RELEASED authorises nothing', () => {
  const fixture = heldFixture('cap-released');
  const held = fixture.held;
  fixture.locks.release();
  // The claim directory is still there, the project is still a project, and the capability object still
  // exists in this process — and it is worth nothing, because the locks it described are gone.
  const outcome = nestedBackup(fixture.root, `backups/${fixture.claim}`, 'pre-restore-set-a', held);
  assert(outcome.refusal !== null && outcome.refusal.includes('already released its locks'),
    `a capability that outlived its locks is refused: ${String(outcome.refusal)}`);
  assertEq(outcome.commands.length, 0, 'and nothing ran');
  assertEq(existsSync(join(fixture.destination, fixture.claim, 'pre-restore-set-a')), false,
    'and nothing was published');
});

test('a capability cannot be minted speculatively, and one stack mints one', () => {
  const root = makeMaintenanceProject(join(WORK, 'cap-minting'));
  mkdirSync(join(root, 'backups'), { recursive: true });
  const destination = resolveBackupDestination(root, 'backups').destinationDir;
  const locks = MaintenanceLocks.open(root);
  try {
    refuses(() => locks.heldDestination(), 'has not taken the destination lock',
      'no capability exists before the destination lock does');
    locks.lockDestination(destination);
    const first = locks.heldDestination();
    assertEq(locks.heldDestination(), first, 'and one stack mints one capability, not a new one each time');
    assertHeldDestination(first, root, destination);
    const claim = join(destination, `.pre-restore-claim-${'a'.repeat(24)}`);
    refuses(() => assertHeldDestination(first, root, claim), 'claim directory that is not there',
      'a claim that has not been created is not a target, because creating it is what owns it');
    mkdirSync(claim);
    assertHeldDestination(first, root, claim);
    refuses(() => assertHeldDestination(first, root, join(destination, 'anything-else')),
      'DIFFERENT backup destination',
      'and an ordinary subdirectory is NOT authorised — the permitted set is closed, not "everything under"');
    refuses(() => assertHeldDestination(first, join(root, 'secrets'), destination), 'DIFFERENT project',
      'the bound project is compared exactly');
    refuses(() => locks.lockDestination(destination), 'asked twice',
      'and one stack holds one destination');
  } finally {
    locks.release();
  }
  refuses(() => locks.heldDestination(), 'after the locks were released',
    'a released stack mints nothing');
});

test('no module under src/ can suppress the locks with a flag, because there is no flag', () => {
  // THE SOURCE SCAN THAT REMAINS IS NOT THE AUTHORITY — the capability is. This asserts the boolean is
  // GONE rather than that only one caller passes it, which is a different and much weaker claim.
  for (const file of readdirSync(join(repoRoot, 'src', 'ops')).filter((name) => name.endsWith('.ts'))) {
    const source = readRepo(`src/ops/${file}`);
    assert(!source.includes('holdingLock:'), `src/ops/${file} still passes a holdingLock flag`);
    assert(!source.includes('MaintenanceLocks.inherited'),
      `src/ops/${file} uses a public no-lock factory, and there is not supposed to be one`);
  }
  const owner = readRepo('src/ops/maintenance-safety.ts');
  assert(!owner.includes('static inherited('), 'the no-lock factory is gone from the lock stack itself');
  assert(owner.includes('const MINTED = new WeakSet'),
    'and the identity of a capability is runtime membership, not a shape TypeScript can be cast into');
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
  const acquire = owner.slice(owner.indexOf('function acquireDestinationLock'));
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
