import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { kekRingExists } from '../core/crypto/kek-ring.js';
import { validateSidecarHealth } from '../core/crypto/sidecar-ipc.js';
import type { SidecarHealth } from '../core/crypto/sidecar-ipc.js';
import { planKekMigration } from './kek-rotation.js';
import {
  BOOTSTRAP_COMPOSE_FILE,
  RUNTIME_COMPOSE_FILE,
  clearCustodyRuntimeMode,
  composeFileArgs,
  readCustodyRuntimeMode,
  writeCustodyRuntimeMode,
  type CustodyRuntimeMode,
} from './custody-runtime-mode.js';
import {
  CommandLedger,
  MaintenanceRefused,
  acquireLockDirectory,
  resolveMaintenanceRoot,
  runGuarded,
  type CommandRunner,
  type MaintenanceCommand,
} from './maintenance-safety.js';

// Phase 290 — moving a shipped installation from static bootstrap custody onto the ring, as a transaction.
//
// -----------------------------------------------------------------------------------------------------
// WHAT AN OPERATOR WAS ASKED TO DO BEFORE THIS, AND WHY NOBODY WOULD FINISH IT.
// -----------------------------------------------------------------------------------------------------
//
// Every piece of this existed and none of it was joined up. `ops:kek-ring migrate` adopts the static KEK as
// generation 1 — planned, digest-confirmed, gated on a backup that is proved to restore custody. What it
// does NOT do is anything about the RUNTIME: after it succeeds the stack is still wired to the static key,
// and the shipped compose file's advice was to edit three lines of YAML by hand and remember to redo it
// after every upgrade. So the actual sequence an operator had to get right, on a NAS, in a web terminal,
// was: take a backup, verify it, stop things in the right order, run a container by hand with exactly the
// right mounts, copy a digest, run it again, edit a shipped file in three places, start things in the right
// order, and check the result — with no rollback if the last step failed.
//
// THIS IS THAT SEQUENCE, AS ONE PLANNED AND CONFIRMED OPERATION. It reimplements no cryptography: the ring
// is written by `runKekMigration` inside the one-shot custody-maintenance container, which is the only
// service that mounts the static key at all.
//
// -----------------------------------------------------------------------------------------------------
// THE ONE THING THIS COMMAND WILL NOT PRETEND ABOUT: WHAT ROLLBACK MEANS AFTER THE MIGRATION RUNS.
// -----------------------------------------------------------------------------------------------------
//
// There are two different things called rollback here and conflating them would be the most dangerous
// sentence this file could contain:
//
//   RUNTIME ROLLBACK — putting the stack back on the compose selection it was running before. That is what
//   this command does when the cutover fails, and it is complete and provable: the marker goes back, the
//   services start again, and the sidecar answers a health handshake.
//
//   STATE ROLLBACK — undoing the migration itself. THIS COMMAND CANNOT DO THAT AND DOES NOT CLAIM TO. Once
//   `runKekMigration` has written a ring, a ring exists in the sidecar state directory; `migrate` refuses to
//   run again against an installation that has one, and nothing here removes it. If the runtime rollback
//   happens after that point, the installation is running on the static key WITH a ring beside it — which is
//   a state to finish from, not a state to be surprised by, and the report says so in those words.
//
// The way back from a migration that must be undone is the backup the plan was gated on. That is the whole
// reason the gate exists, and it is why this refuses to plan without one.

export const CUSTODY_CUTOVER_REPORT = 'phase-290-custody-cutover';
export const CUSTODY_CUTOVER_VERSION = 1;

/** The lock that makes this one-at-a-time against one installation. */
export const CUSTODY_CUTOVER_LOCK_DIRNAME = '.catalog-custody-cutover.lock';

/** Where the container sees what the host mounts. Fixed by the compose files; not an operator's choice. */
export const CONTAINER_STATE_DIR = '/var/lib/catalog-sidecar/state';
export const CONTAINER_ROOT_KEY_FILE = '/run/catalog-custody/custodian_root_key';
export const CONTAINER_STATIC_KEY_FILE = '/run/catalog-custody/custodian_kek';
export const CONTAINER_BACKUPS_DIR = '/backups';
export const CONTAINER_SOCKET_PATH = '/run/catalog-sidecar/catalog-sidecar.sock';

/** The services this transaction quiesces, in the order it stops them. Started again in reverse. */
export const CUTOVER_QUIESCED_SERVICES: readonly string[] = Object.freeze(['app', 'sidecar']);

export interface CustodyCutoverRequest {
  /** The project directory holding the compose files and the mode marker. */
  readonly projectRoot: string;
  /** The compose project name, so every command addresses one stack explicitly. */
  readonly projectName: string;
  /**
   * The name of the backup set inside the backups directory the compose files already mount.
   *
   * A NAME, NOT A PATH. The container sees the backups directory at a fixed mount point, so what the plan
   * needs is which set inside it — and a name cannot climb out of the mount.
   */
  readonly backupSetName: string;
  /** The HOST paths the plan reads to prove the migration. Read-only, every one of them. */
  readonly hostStateDir: string;
  readonly hostRootKeyFile: string;
  readonly hostStaticKeyFile: string;
  readonly hostBackupsDir: string;
}

export interface ResolvedCustodyCutover extends CustodyCutoverRequest {
  readonly planDigest: string;
  readonly fromMode: CustodyRuntimeMode;
  readonly toMode: CustodyRuntimeMode;
  /**
   * Which HALF of this transaction is still to be done.
   *
   * A CUTOVER IS TWO OPERATIONS AND THE FIRST ONE IS NOT REVERSIBLE. If the ring was written and the runtime
   * switch did not finish — a NAS rebooted, a container did not come up, the command was interrupted — the
   * installation is in a real state that has to be finishable: bootstrap runtime, ring present. `migrate`
   * refuses to run twice, so a plan that always tried to migrate would leave that installation with no way
   * forward but a manual one, which is the failure this whole tranche exists to remove.
   */
  readonly stage: 'migrate-and-switch' | 'switch-only';
  /**
   * The migration's own plan digest, computed by `planKekMigration` INSIDE the container.
   *
   * WHY IT COMES FROM THE CONTAINER AND NOT FROM HERE. That digest binds the state directory's PATH, and the
   * container's path is not the host's. A digest computed on the host could never be confirmed by the
   * command that runs in the container, so the planning step asks the container for its own — with `--plan`,
   * which writes nothing to this installation — and this transaction's digest binds THAT.
   *
   * `null` on a resume: there is no migration left to confirm, because one already happened.
   */
  readonly migrationPlanDigest: string | null;
  /** A digest of the resolved compose configuration, so a changed stack is a changed plan. */
  readonly composeConfigDigest: string;
  readonly composeFiles: readonly string[];
}

export interface CustodyCutoverReport {
  readonly report: typeof CUSTODY_CUTOVER_REPORT;
  readonly version: typeof CUSTODY_CUTOVER_VERSION;
  readonly ok: boolean;
  readonly planDigest: string;
  readonly fromMode: CustodyRuntimeMode;
  readonly toMode: CustodyRuntimeMode;
  /** Whether THIS RUN wrote the ring. Once true, no runtime action undoes it. */
  readonly migrationPerformed: boolean;
  /**
   * Whether this run finished a cutover whose migration had already happened.
   *
   * Reported separately from `migrationPerformed` because they are different facts and an operator reading a
   * report of a resume must not be told a migration ran when it did not.
   */
  readonly resumed: boolean;
  /** The custody mechanism the sidecar reported after the cutover. A closed word from its own schema. */
  readonly custodian: SidecarHealth['custodian'] | null;
  readonly ringGeneration: number | null;
  readonly network: 'none';
  readonly notes: readonly string[];
}

export interface CustodyCutoverDeps {
  readonly runner: CommandRunner;
  readonly ledger: CommandLedger;
}

/**
 * Resolve a cutover and CHANGE NOTHING ABOUT THIS INSTALLATION.
 *
 * WHAT "READ-ONLY" MEANS HERE, EXACTLY, BECAUSE IT IS NOT "RUNS NOTHING". Planning executes two commands:
 * `compose config`, which renders the merged configuration and touches nothing; and `compose run --rm
 * --no-deps custody-maintenance ops:kek-ring migrate --plan`, which STARTS A CONTAINER. That container is
 * real — it is created, it runs, and `--rm` removes it when it exits.
 *
 * What it does not do is change the installation. Its mounts are the state directory, the key files and the
 * backups; `planKekMigration` is a pure function of what it finds there and writes nothing; and the
 * container is removed on exit. So: no service is stopped or started, no marker moves, no ring is written,
 * no key file is touched and no image is pulled or built — but a container is created and destroyed, and
 * saying "this runs nothing" would be a claim an operator could disprove by watching `docker ps`.
 *
 * ON A RESUME, EVEN THAT IS SKIPPED. If a ring already exists there is no migration left to plan, and the
 * only command planning runs is `compose config`.
 */
export function planCustodyCutover(
  request: CustodyCutoverRequest,
  deps: CustodyCutoverDeps,
): ResolvedCustodyCutover {
  const projectRoot = resolveMaintenanceRoot(request.projectRoot, 'project directory');
  const hostStateDir = resolveMaintenanceRoot(request.hostStateDir, 'sidecar state directory');
  const hostBackupsDir = resolveMaintenanceRoot(request.hostBackupsDir, 'backups directory');
  if (request.projectName.trim() === '') throw new MaintenanceRefused('the compose project name was not given');
  assertSetName(request.backupSetName);

  // ---- THE INSTALLATION MUST BE IN BOOTSTRAP MODE, OR THERE IS NOTHING TO CUT OVER ---------------------
  const selection = readCustodyRuntimeMode(projectRoot);
  if (selection.mode !== 'bootstrap') {
    throw new MaintenanceRefused(
      'this installation is not in custody bootstrap mode, so there is no static-custody runtime to move off. '
      + 'An installation already in the steady state has nothing for this command to do; one that has never '
      + 'declared a mode is treated as being in the steady state, which is what a fresh install is. Nothing '
      + 'was changed.');
  }

  // ---- IS THERE ALREADY A RING? THAT DECIDES WHICH HALF IS LEFT ----------------------------------------
  //
  // A ring in the state directory of an installation whose runtime is still on bootstrap is an INTERRUPTED
  // CUTOVER, not a contradiction: the migration completed and the runtime switch did not. `migrate` refuses
  // to run against an installation that has a ring — correctly — so this plans the remaining half instead of
  // planning something that cannot run.
  const stage = kekRingExists(hostStateDir) ? 'switch-only' as const : 'migrate-and-switch' as const;

  const composeConfig = runGuarded(deps.runner, deps.ledger, composeCommand(projectRoot, request.projectName,
    'bootstrap', ['config'], 'render the merged compose configuration this cutover would act on'));
  if (composeConfig.status !== 0) {
    throw new MaintenanceRefused(
      'the compose configuration for this project did not resolve, so there is no stack to describe. Nothing '
      + 'was changed.');
  }

  // ---- THE MIGRATION, PROVED ON THE HOST AND THEN ASKED FOR ITS OWN DIGEST -----------------------------
  //
  // The host-side plan is what refuses early and legibly: it verifies the backup set, proves it can restore
  // custody, proves the static key opens every wrapped key, and binds the exact key set. The container's
  // digest is what the confirmed run will echo back, and it is obtained with `--plan`.
  let migrationPlanDigest: string | null = null;
  if (stage === 'migrate-and-switch') {
    planKekMigration({
      stateDir: hostStateDir,
      rootKeyFile: request.hostRootKeyFile,
      staticKeyFile: request.hostStaticKeyFile,
      backupSet: join(hostBackupsDir, request.backupSetName),
    });
    migrationPlanDigest = readPlanDigest(runGuarded(deps.runner, deps.ledger,
      migrationCommand(projectRoot, request.projectName, request.backupSetName, ['--plan'],
        'ask the custody-maintenance container for the migration plan it would confirm')));
  }

  const resolved = {
    ...request,
    projectRoot,
    hostStateDir,
    hostBackupsDir,
    projectName: request.projectName.trim(),
    fromMode: 'bootstrap' as const,
    toMode: 'root-only' as const,
    stage,
    migrationPlanDigest,
    composeConfigDigest: createHash('sha256').update(composeConfig.stdout, 'utf8').digest('hex'),
    composeFiles: [RUNTIME_COMPOSE_FILE, BOOTSTRAP_COMPOSE_FILE] as readonly string[],
  };
  // FROZEN. A plan is a decision an operator confirmed; a caller able to edit one between the print and the
  // run would be editing the thing the digest binds.
  return Object.freeze({ ...resolved, planDigest: custodyCutoverPlanDigest(resolved) });
}

/** Over which project, which stack, which merged configuration and which exact migration. */
export function custodyCutoverPlanDigest(plan: Omit<ResolvedCustodyCutover, 'planDigest'>): string {
  return createHash('sha256').update(JSON.stringify({
    report: CUSTODY_CUTOVER_REPORT,
    version: CUSTODY_CUTOVER_VERSION,
    // THE PATH IS DIGESTED, NEVER NAMED. A plan digest an operator pastes into a ticket carries no host
    // layout, and this file's reports carry none either.
    projectRoot: createHash('sha256').update(plan.projectRoot, 'utf8').digest('hex'),
    projectName: plan.projectName,
    fromMode: plan.fromMode,
    toMode: plan.toMode,
    composeFiles: [...plan.composeFiles],
    composeConfigDigest: plan.composeConfigDigest,
    // THE BACKUP'S IDENTITY AND THE EXACT PRE-STATE, both already inside the migration's own digest: it
    // binds the verified set's digest, a digest of the exact set of wrapped key files, the root key's label
    // and the static key's label. Binding it here binds all of that without recomputing any of it.
    stage: plan.stage,
    migrationPlanDigest: plan.migrationPlanDigest,
    backupSetName: plan.backupSetName,
  }), 'utf8').digest('hex');
}

/**
 * Perform the cutover, having re-resolved everything, and prove the result or put the runtime back.
 */
export function runCustodyCutover(
  request: CustodyCutoverRequest & { readonly confirmDigest: string | null },
  deps: CustodyCutoverDeps,
): CustodyCutoverReport {
  const first = planCustodyCutover(request, deps);
  if (request.confirmDigest !== first.planDigest) {
    throw new MaintenanceRefused(
      'the digest you confirmed is not the digest of the cutover this command just computed. Nothing was '
      + 'changed. Run with --plan, read it, and copy the digest from the plan you actually read.');
  }
  const lock = acquireLockDirectory(join(first.hostStateDir, CUSTODY_CUTOVER_LOCK_DIRNAME),
    'another custody operation is already running against this installation, or one was interrupted and left '
    + 'its lock behind.');
  const notes: string[] = [];
  const quiesced: string[] = [];
  let migrationPerformed = false;
  try {
    // ---- RE-RESOLVED UNDER THE LOCK ------------------------------------------------------------------
    const resolved = planCustodyCutover(request, deps);
    if (resolved.planDigest !== first.planDigest) {
      throw new MaintenanceRefused(
        'the stack, the backup or the keystore changed between reading this plan and running it. Nothing was '
        + 'changed and nothing was stopped. Re-run with --plan against what is actually there.');
    }

    try {
      // ---- QUIESCE ------------------------------------------------------------------------------------
      //
      // The app first, then the sidecar: the app is the only thing that asks the sidecar for keys, and
      // stopping the sidecar under a live app would make every catalog read fail while the migration ran.
      for (const service of CUTOVER_QUIESCED_SERVICES) {
        const stop = runGuarded(deps.runner, deps.ledger, composeCommand(resolved.projectRoot,
          resolved.projectName, 'bootstrap', ['stop', service], `stop ${service} for the custody cutover`));
        if (stop.status !== 0) {
          throw new MaintenanceRefused(
            `the ${service} service could not be stopped, so a migration would run against a live writer. `
            + 'Nothing was changed.');
        }
        quiesced.push(service);
      }

      // ---- THE MIGRATION ITSELF, IN THE ONE-SHOT CONTAINER --------------------------------------------
      //
      // Everything after this point is AFTER the ring exists. `runKekMigration` is what writes it, under
      // both of the custodian's locks, having re-proved the whole plan inside the container.
      //
      // SKIPPED ON A RESUME, BECAUSE IT HAS ALREADY HAPPENED. A ring in a bootstrap installation is an
      // interrupted cutover; re-running `migrate` against it would be refused by the migration itself, and
      // this transaction would report a failure for an installation whose only remaining problem is that its
      // runtime selection did not move.
      if (resolved.stage === 'migrate-and-switch') {
        const migrate = runGuarded(deps.runner, deps.ledger,
          migrationCommand(resolved.projectRoot, resolved.projectName, resolved.backupSetName,
            ['--confirm-digest', resolved.migrationPlanDigest!], 'adopt the static KEK as generation 1 of the ring'));
        if (migrate.status !== 0) {
          throw new MaintenanceRefused(
            'the custody migration did not complete, so no ring was written and this installation is exactly as '
            + 'it was. The runtime is put back below.');
        }
        migrationPerformed = true;
      }

      // ---- SWITCH THE RUNTIME SELECTION ---------------------------------------------------------------
      //
      // NOT AN EDIT TO A SHIPPED FILE. The marker is removed, which returns the project to the steady state
      // — one compose file, root-only custody, no static key mounted anywhere.
      clearCustodyRuntimeMode(resolved.projectRoot);

      // ---- START AGAIN, INTO ROOT-ONLY CUSTODY --------------------------------------------------------
      startQuiesced(resolved, deps, 'root-only');
      quiesced.length = 0;

      // ---- AND PROVE IT ------------------------------------------------------------------------------
      const health = probeCutoverHealth(resolved, deps, 'root-only');
      if (health === null || health.custodian !== expectedCustodianFor('root-only')) {
        throw new CutoverHealthRefused(health === null
          ? 'the sidecar did not answer a health handshake after the cutover'
          : 'the sidecar answered, and it is not running the managed ring this cutover was for');
      }
      notes.push(
        resolved.stage === 'switch-only'
          ? 'A ring was ALREADY in this state directory when this ran, so this command finished an interrupted '
            + 'cutover: it performed no migration and moved the runtime selection to the steady state.'
          : 'The static KEK is now generation 1 of a sidecar-managed ring, and the runtime selection is the '
            + 'steady state: one compose file, the root wrapping key, and no static KEK mounted anywhere.',
        'AFTER THIS, ROTATE. Adoption changes the custody MECHANISM and not the key: every wrapped key is '
        + 'still under the key that was in a file until a rotation moves them onto one the sidecar generated.',
      );
      return {
        report: CUSTODY_CUTOVER_REPORT,
        version: CUSTODY_CUTOVER_VERSION,
        ok: true,
        planDigest: resolved.planDigest,
        fromMode: resolved.fromMode,
        toMode: resolved.toMode,
        migrationPerformed,
        resumed: resolved.stage === 'switch-only',
        custodian: health.custodian,
        ringGeneration: health.ringGeneration,
        network: 'none',
        notes,
      };
    } catch (err) {
      // ---- RUNTIME ROLLBACK, AND AN HONEST ACCOUNT OF WHAT IT DID AND DID NOT UNDO --------------------
      throw rollbackRuntime(resolved, deps, err, migrationPerformed);
    }
  } finally {
    lock.release();
  }
}

/**
 * A cutover whose health handshake did not prove what the cutover was for.
 *
 * Its own kind so a caller can tell it from a refusal that happened before anything moved.
 */
export class CutoverHealthRefused extends MaintenanceRefused {
  constructor(primary: string) {
    super(primary);
    this.name = 'CutoverHealthRefused';
  }
}

/**
 * A cutover that failed AND what state the installation was left in.
 *
 * TWO FACTS, AND THE SECOND IS THE ONE AN OPERATOR ACTS ON. The primary failure says why the cutover stopped;
 * `migrationPerformed` says whether a ring exists — and if it does, no runtime action removes it.
 */
export class CustodyCutoverFailed extends MaintenanceRefused {
  readonly primary: string;
  readonly migrationPerformed: boolean;
  readonly runtimeRestored: boolean;

  constructor(primary: string, migrationPerformed: boolean, runtimeRestored: boolean) {
    super([
      primary,
      runtimeRestored
        ? 'THE RUNTIME WAS PUT BACK: this installation is running the custody selection it was running before '
          + 'this command, and its sidecar answered a health handshake.'
        : 'AND THE RUNTIME COULD NOT BE PUT BACK. The stack may be stopped or running on a selection it cannot '
          + 'serve. That is the more urgent of these two problems: start it with the documented bootstrap '
          + 'command and check ops:doctor before anything else.',
      migrationPerformed
        ? 'A RING WAS ALREADY WRITTEN BEFORE THIS FAILED, AND PUTTING THE RUNTIME BACK DOES NOT REMOVE IT. '
          + 'Runtime rollback and state rollback are different things and this command only does the first: '
          + 'the installation is running on the static key with a ring beside it. That is a state to finish '
          + 'from — re-run the cutover once the runtime problem is fixed — or to leave from by restoring the '
          + 'verified backup this cutover was gated on. Nothing here removes a ring.'
        : 'NO RING WAS WRITTEN. The migration did not run or did not complete, so this installation is '
          + 'cryptographically exactly as it was.',
    ].join(' '));
    this.name = 'CustodyCutoverFailed';
    this.primary = primary;
    this.migrationPerformed = migrationPerformed;
    this.runtimeRestored = runtimeRestored;
  }
}

/** Put the bootstrap selection back, start the stack on it, and prove the sidecar answers. Never throws. */
function rollbackRuntime(
  resolved: ResolvedCustodyCutover,
  deps: CustodyCutoverDeps,
  cause: unknown,
  migrationPerformed: boolean,
): CustodyCutoverFailed {
  const primary = cause instanceof MaintenanceRefused ? cause.message : 'the custody cutover did not complete';
  let restored = false;
  try {
    writeCustodyRuntimeMode(resolved.projectRoot, 'bootstrap');
    startQuiesced(resolved, deps, 'bootstrap');
    // PROVED, NOT ASSUMED. "Put back" means the sidecar answers a handshake on the selection it was on
    // before, not that a `start` command exited zero.
    // THE ANSWER MUST BE THE ONE THIS SELECTION IS FOR. A sidecar reporting the managed ring on the bootstrap
    // selection is not the runtime that was there before; calling that "put back" would be the same class of
    // false claim this file exists to avoid.
    const health = probeCutoverHealth(resolved, deps, 'bootstrap');
    restored = health !== null && health.custodian === expectedCustodianFor('bootstrap');
  } catch {
    restored = false;
  }
  return new CustodyCutoverFailed(primary, migrationPerformed, restored);
}

/** Start what the cutover stopped, in the reverse of the order it stopped them. */
function startQuiesced(
  resolved: ResolvedCustodyCutover,
  deps: CustodyCutoverDeps,
  mode: CustodyRuntimeMode,
): void {
  for (const service of [...CUTOVER_QUIESCED_SERVICES].reverse()) {
    const start = runGuarded(deps.runner, deps.ledger, composeCommand(resolved.projectRoot, resolved.projectName,
      mode, ['up', '-d', '--no-build', '--pull', 'never', service], `start ${service} on the ${mode} selection`));
    if (start.status !== 0) {
      throw new MaintenanceRefused(`the ${service} service did not start on the ${mode} selection`);
    }
  }
}

/**
 * Which custody mechanism a sidecar MUST report on each selection.
 *
 * A MODE-SPECIFIC ANSWER, NOT MERELY AN ANSWER. A rollback that accepted any valid handshake would report
 * "the runtime was put back" for a stack that had come up on the wrong wiring entirely — and after a
 * migration the bootstrap selection is exactly where that could happen, because a ring now exists beside the
 * static key the sidecar is being told to use.
 */
export function expectedCustodianFor(mode: CustodyRuntimeMode): SidecarHealth['custodian'] {
  return mode === 'root-only' ? 'sidecar-managed-ring' : 'file-reference-harness';
}

/** One health handshake, through the ops container that already has the socket directory read-only. */
function probeCutoverHealth(
  resolved: ResolvedCustodyCutover,
  deps: CustodyCutoverDeps,
  mode: CustodyRuntimeMode,
): SidecarHealth | null {
  const outcome = runGuarded(deps.runner, deps.ledger, composeCommand(resolved.projectRoot, resolved.projectName,
    mode, ['run', '--rm', '--no-deps', 'ops', 'ops:sidecar-health', '--', '--socket', CONTAINER_SOCKET_PATH, '--json'],
    'ask the sidecar for a health handshake'));
  if (outcome.status !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastJsonLine(outcome.stdout));
  } catch {
    return null;
  }
  // THE STRICT SCHEMA, REUSED. A health answer this build would not act on anywhere else is not one to act
  // on here either, and there is exactly one definition of that.
  return validateSidecarHealth(parsed);
}

function composeCommand(
  projectRoot: string,
  projectName: string,
  mode: CustodyRuntimeMode,
  args: readonly string[],
  purpose: string,
): MaintenanceCommand {
  return {
    program: 'docker',
    args: ['compose', ...composeFileArgs(mode), '-p', projectName, ...args],
    cwd: projectRoot,
    purpose,
  };
}

/** The one-shot migration command, always on the bootstrap selection, always with container paths. */
function migrationCommand(
  projectRoot: string,
  projectName: string,
  backupSetName: string,
  tail: readonly string[],
  purpose: string,
): MaintenanceCommand {
  return composeCommand(projectRoot, projectName, 'bootstrap', [
    'run', '--rm', '--no-deps', 'custody-maintenance',
    'ops:kek-ring', '--', 'migrate',
    '--state', CONTAINER_STATE_DIR,
    '--root-file', CONTAINER_ROOT_KEY_FILE,
    '--static-file', CONTAINER_STATIC_KEY_FILE,
    '--backup-set', `${CONTAINER_BACKUPS_DIR}/${backupSetName}`,
    ...tail,
  ], purpose);
}

/** The plan digest the container printed, or a refusal. Never a guess. */
function readPlanDigest(outcome: { readonly status: number; readonly stdout: string }): string {
  if (outcome.status !== 0) {
    throw new MaintenanceRefused(
      'the custody-maintenance container would not plan this migration, so there is nothing to confirm. '
      + 'Nothing was changed.');
  }
  const match = /plan digest:\s*([0-9a-f]{64})/.exec(outcome.stdout);
  if (match === null) {
    throw new MaintenanceRefused(
      'the custody-maintenance container did not print a plan digest this command could read. Nothing was '
      + 'changed.');
  }
  return match[1]!;
}

/** The last line that looks like a JSON object. `npm run` prefixes its own lines to stdout. */
function lastJsonLine(stdout: string): string {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
  if (lines.length === 0) return '';
  return lines[lines.length - 1]!;
}

/** A backup set NAME: one path segment, of the shape this product's own sets have. */
function assertSetName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(name)) {
    throw new MaintenanceRefused(
      'the backup set name is not one this command will use. It is a NAME inside the backups directory the '
      + 'stack already mounts, not a path: a name cannot climb out of that mount and a path could.');
  }
}
