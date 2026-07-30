import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import { RUNTIME_ROLE_NAME } from './bootstrap.js';
import { COMPONENT_ARTIFACT_NAMES, type BackupComponentId } from './backup-components.js';
import {
  copyTree,
  digestTreeAt,
  readBackupManifest,
  runVerifiedCompleteBackup,
  type CompleteBackupOutcome,
} from './complete-backup.js';
import { verifyBackupSet, type BackupVerificationReport } from './backup-set-verification.js';
import { classifyDoctor, parseDoctorJson } from './doctor-monitor.js';
import { readSchemaVersions } from './upgrade-rehearsal.js';
import {
  RESTORE_STEP_PURPOSE,
  DESTRUCTIVE_STEP_IDS,
  PROOF_STEP_IDS,
  requiredPlacementIds,
  stepsFor,
  swapReplacedName,
  swapStagingName,
  type CustodianTopology,
  type RestoreStepId,
} from './restore-model.js';
import {
  MaintenanceRefused,
  acquireMaintenanceLock,
  assertPlainTree,
  assertUsableName,
  readFileNoFollow,
  resolveInsideRoot,
  resolveMaintenanceRoot,
  runGuarded,
  runGuardedFromFile,
  stagingSuffix,
  writePrivateFile,
  type CommandLedger,
  type CommandOutcome,
  type CommandRunner,
  type FileInputRunner,
  type FileOutputRunner,
  type MaintenanceCommand,
} from './maintenance-safety.js';

// Phases 298-303 — putting a verified set back into a real installation.
//
// WHAT WAS MISSING, AND IT WAS THE HALF THAT MATTERS ON THE DAY. Phase 277 made taking a complete backup a
// command and Phase 278 verified it in the same run. Phases 279-280 restored one END TO END — in a THROWAWAY
// PROJECT, which was the point of a rehearsal and is also its limit. An operator holding a verified set and a
// broken installation had four numbered steps in a document, of which step two is four components, an
// ordering, a schema decision, a cluster role `pg_dump` does not carry, and a database that must be EMPTY
// before a dump is replayed into it. The one part of this product's lifecycle with no command was the part
// performed by somebody who had just lost something.
//
// THIS COMPOSES, IT DOES NOT REDEFINE. The component list is `backup-components.ts`'s. The placements are
// `restore-model.ts`'s. The set is verified by Phase 278's `verifyBackupSet` — before it is read, and AGAIN
// under the lock. The safety set is taken by Phase 277's own `runVerifiedCompleteBackup`, not by a second
// implementation of a backup. There is no second answer here to any question another phase has answered.
//
// -----------------------------------------------------------------------------------------------------
// EVERYTHING THAT CAN REFUSE HAPPENS BEFORE ANYTHING IS DESTROYED.
// -----------------------------------------------------------------------------------------------------
//
// `stop-and-destroy` is `docker compose down -v`, and it is irreversible. Every path resolution, every
// classification, the set verification, the topology agreement and the plan-digest re-proof happen before it.
// A restore that refuses has changed NOTHING, and a restore that has passed that step has either a verified
// safety set behind it or an explicit, digest-bound acknowledgement that there is none.
//
// -----------------------------------------------------------------------------------------------------
// AND THE PROOF AFTERWARDS INCLUDES A DECRYPTION.
// -----------------------------------------------------------------------------------------------------
//
// An installation whose keystore did not arrive STARTS, PASSES EVERY CHECK AND REPORTS ITSELF HEALTHY,
// because a fail-closed unreadable item is indistinguishable from a correctly erased one. That sentence is
// `backup-components.ts`'s, it is why the keystore is a component at all, and it means a restore that proves
// only liveness has proved nothing about the thing most likely to have gone wrong. So one of the four proofs
// is a shipped primitive that MUST DECRYPT to answer.

export const COMPLETE_RESTORE_REPORT = 'phase-297-304-complete-restore';
export const COMPLETE_RESTORE_VERSION = 1;

/** The journal a run in progress leaves in the project root. Private, and refused by a second run. */
export const RESTORE_JOURNAL_NAME = '.catalog-restore.journal.json';
export const RESTORE_JOURNAL_VERSION = 1;
/** A journal is small by construction. A file at that name larger than this is not one of ours. */
export const MAX_JOURNAL_BYTES = 64 * 1024;

/** Where the keystore lands inside the app container, in inline custody. Fixed by this project's images. */
export const INLINE_KEYSTORE_CONTAINER_PATH = '/var/lib/catalog/keystore';

/** How long the two `up` steps wait for their declared healthchecks, in seconds. */
export const DATABASE_WAIT_SECONDS = 60;
export const STACK_WAIT_SECONDS = 120;

// -----------------------------------------------------------------------------------------------------------
// The request, and what resolving it proves
// -----------------------------------------------------------------------------------------------------------

export interface CompleteRestoreRequest {
  /** The Compose project directory, absolute. Resolved and proved to be a real, contained, non-broad root. */
  readonly projectRoot: string;
  /** Where sets are kept, relative to the project root. */
  readonly destination: string;
  /** The set to restore, inside the destination. */
  readonly setName: string;
  /**
   * The custody topology of THIS INSTALLATION, declared. It must also agree with the set's own manifest — a
   * sidecar set restored as inline puts key material in a volume the sidecar never reads.
   */
  readonly custodian: CustodianTopology;
  /** The sidecar's state directory, relative to the project root. REQUIRED in sidecar mode, refused inline. */
  readonly sidecarState?: string;
  /** The promotion-records directory, relative to the project root. */
  readonly promotionRecords?: string;
  /** The secrets directory, relative to the project root. */
  readonly secrets: string;
  /** What to call the safety set. Refused if one of that name already exists, like any other set. */
  readonly safetySetName?: string;
}

/**
 * Whether the installation being restored INTO has anything to lose.
 *
 * DELIBERATELY NOT A DATABASE PROBE. Asking the database would mean starting it, and by the time a restore
 * has started something it has already changed the installation it was asked to judge. Host state is what
 * this can see without touching anything, and host state is enough to decide the only question this answers:
 * whether a safety set is mandatory.
 */
export type TargetState = 'EMPTY' | 'OCCUPIED';

export interface ResolvedRestore {
  readonly projectRoot: string;
  readonly setDir: string;
  readonly setName: string;
  readonly custodian: CustodianTopology;
  readonly sidecarStateDir: string | null;
  readonly sidecarStateName: string | null;
  readonly secretsDir: string;
  readonly secretsName: string;
  readonly promotionRecordsDir: string | null;
  readonly promotionRecordsName: string | null;
  /**
   * The operator's own relative strings, kept because the SAFETY SET is Phase 277's command and its request
   * takes relatives, not resolved paths. Carrying them means the safety set is taken of exactly the
   * directories this restore is about to replace, rather than of a second interpretation of the same flags.
   */
  readonly secretsRelative: string;
  readonly sidecarStateRelative: string | null;
  readonly promotionRecordsRelative: string | null;
  /** Where the safety set would be taken, relative to the project. The backup command's own arguments. */
  readonly destination: string;
  readonly safetySetName: string;
  /** Which components the set actually carries, decided by the manifest and checked on disk. */
  readonly present: readonly BackupComponentId[];
  readonly targetState: TargetState;
  readonly verification: BackupVerificationReport;
}

/**
 * Validate a request into resolved, proved paths, and verify the set.
 *
 * SEPARATE FROM RUNNING IT, so `--plan` and a suite see exactly what would happen with no service stopped.
 * Every refusal in this function happens before anything is created and before any service is touched.
 */
export function resolveCompleteRestoreRequest(request: CompleteRestoreRequest): ResolvedRestore {
  const projectRoot = resolveMaintenanceRoot(request.projectRoot, 'project root');
  assertUsableName(request.setName, 'backup set name');
  const safetySetName = request.safetySetName ?? `pre-restore-${request.setName}`;
  assertUsableName(safetySetName, 'safety set name');
  if (safetySetName === request.setName) {
    throw new MaintenanceRefused(
      'the safety set would be given the same name as the set being restored. An existing set name is refused, so '
      + 'this run could never publish one — and a safety set that overwrote the set it was protecting you from '
      + 'losing would be the worst possible outcome of a command that exists to prevent exactly that.');
  }

  const destinationDir = resolveInsideRoot(projectRoot, request.destination, 'backup destination');
  const setDir = resolveMaintenanceRoot(join(destinationDir, request.setName), 'backup set directory');

  // ---- 1. IS THE SET RESTORABLE AT ALL --------------------------------------------------------------
  //
  // TWO DIFFERENT FACTS, AND BOTH ARE REQUIRED. `ok` says the set is intact and unchanged since it was taken.
  // `restorableUnderThisBuild` says this build could actually replay it — an INTACT set from an older build
  // verifies and is NOT restorable here, and saying so is the entire point of that flag.
  const verification = verifyBackupSet(setDir);
  if (!verification.ok) {
    throw new MaintenanceRefused(
      'the set this restore was pointed at does not verify, so nothing was stopped and nothing was changed. Run '
      + 'ops:backup-inspect on it to see what it holds. A restore from a set that does not verify is a restore '
      + 'nobody could check afterwards.');
  }
  if (!verification.restorableUnderThisBuild) {
    throw new MaintenanceRefused(
      `this set is INTACT and is not restorable by this build: it was taken at schema version `
      + `${verification.manifestSchemaVersion} and this build understands ${MIGRATION_VERSION}. That makes it a `
      + 'rollback point for the version it came from — put that version\'s image back and restore under it. '
      + 'Nothing was stopped and nothing was changed.');
  }

  // ---- 2. DOES THE SET'S TOPOLOGY AGREE WITH THE ONE DECLARED ---------------------------------------
  const manifest = readBackupManifest(setDir);
  if (manifest.custodian !== request.custodian) {
    throw new MaintenanceRefused(
      `this set was taken from an installation with ${manifest.custodian} custody and this restore was told `
      + `${request.custodian}. This command will not choose which of the two you meant: restoring key material `
      + 'into the place the other topology reads it from produces an installation that starts, passes every '
      + 'check and decrypts nothing.');
  }

  const present = manifest.components.filter((component) => component.present).map((component) => component.id);
  for (const id of requiredPlacementIds(request.custodian)) {
    if (!present.includes(id)) {
      throw new MaintenanceRefused(
        `this set does not carry the ${id} component, so it cannot be restored. Nothing was changed.`);
    }
  }

  // ---- 3. THE TARGETS ------------------------------------------------------------------------------
  //
  // TOPOLOGY IS STATED, AND STATED EXCLUSIVELY — the same rule Phase 277 applies to taking one, for the same
  // reason. An ignored path is a path somebody will believe was used.
  let sidecarStateDir: string | null = null;
  let sidecarStateName: string | null = null;
  if (request.custodian === 'sidecar') {
    if (request.sidecarState === undefined || request.sidecarState.trim() === '') {
      throw new MaintenanceRefused(
        'sidecar custody was declared but no sidecar state directory was given. This command will not guess where '
        + 'the keystore goes: a restore that placed it in the wrong directory would look complete and leave an '
        + 'installation that can decrypt nothing.');
    }
    sidecarStateDir = resolveInsideRoot(projectRoot, request.sidecarState, 'sidecar state directory');
    sidecarStateName = lastSegment(request.sidecarState);
    if (existsSync(sidecarStateDir)) assertPlainTree(sidecarStateDir, 'sidecar state directory');
  } else if (request.sidecarState !== undefined) {
    throw new MaintenanceRefused(
      'a sidecar state directory was given with inline custody. One of the two is wrong, and this command will not '
      + 'choose which.');
  }

  const secretsDir = resolveInsideRoot(projectRoot, request.secrets, 'secrets directory');
  if (existsSync(secretsDir)) assertPlainTree(secretsDir, 'secrets directory');

  let promotionRecordsDir: string | null = null;
  let promotionRecordsName: string | null = null;
  const setHasRecords = present.includes('promotion-records');
  if (setHasRecords) {
    if (request.promotionRecords === undefined || request.promotionRecords.trim() === '') {
      throw new MaintenanceRefused(
        'this set carries promotion record artifacts and no promotion-records directory was given, so there is '
        + 'nowhere to put them. Name one, or take a set without them. This command will not silently drop a '
        + 'component it was handed — those files are the operator\'s own and this product cannot recreate them.');
    }
    promotionRecordsDir = resolveInsideRoot(projectRoot, request.promotionRecords, 'promotion records directory');
    promotionRecordsName = lastSegment(request.promotionRecords);
    if (existsSync(promotionRecordsDir)) assertPlainTree(promotionRecordsDir, 'promotion records directory');
  } else if (request.promotionRecords !== undefined && request.promotionRecords.trim() !== '') {
    // NOT A REFUSAL. A set without records is a correct and permanent state for most installations, and an
    // operator who always passes the same flags should not be stopped by one. The directory is simply not a
    // placement, and the plan will not list a step for it.
    promotionRecordsDir = null;
  }

  return {
    projectRoot,
    setDir,
    setName: request.setName,
    custodian: request.custodian,
    sidecarStateDir,
    sidecarStateName,
    secretsDir,
    secretsName: lastSegment(request.secrets),
    promotionRecordsDir,
    promotionRecordsName,
    secretsRelative: request.secrets,
    sidecarStateRelative: request.custodian === 'sidecar' ? request.sidecarState! : null,
    // The safety set backs up the records directory only when THIS restore will replace it. A directory the
    // set has nothing for is not this run's to capture, and Phase 277 treats an absent one as absent anyway.
    promotionRecordsRelative: promotionRecordsDir === null ? null : request.promotionRecords!,
    destination: request.destination,
    safetySetName,
    present,
    targetState: classifyTarget({ secretsDir, promotionRecordsDir, sidecarStateDir }),
    verification,
  };
}

/**
 * Is there anything here to lose?
 *
 * OCCUPIED on the FIRST sign of state, never on the absence of all of it. A directory that cannot be listed
 * counts as occupied: "I could not see it" is not "it is not there", and the consequence of getting this
 * wrong in the safe direction is one extra verified backup.
 */
export function classifyTarget(dirs: {
  readonly secretsDir: string;
  readonly promotionRecordsDir: string | null;
  readonly sidecarStateDir: string | null;
}): TargetState {
  for (const dir of [dirs.secretsDir, dirs.promotionRecordsDir, dirs.sidecarStateDir]) {
    if (dir === null) continue;
    const stats = lstatSync(dir, { throwIfNoEntry: false });
    if (stats === undefined) continue;
    if (!stats.isDirectory()) return 'OCCUPIED';
    try {
      if (readdirSync(dir).length > 0) return 'OCCUPIED';
    } catch {
      return 'OCCUPIED';
    }
  }
  return 'EMPTY';
}

// -----------------------------------------------------------------------------------------------------------
// The plan
// -----------------------------------------------------------------------------------------------------------

export interface RestorePlanStep {
  readonly id: RestoreStepId;
  /** What it establishes, in one sentence. `restore-model.ts`'s, never retyped. */
  readonly proves: string;
  /** Whether the installation is not where it was once this step has completed. */
  readonly destructive: boolean;
  /** The commands it issues, in order, as values. Empty for a step that only moves files on this host. */
  readonly commands: readonly MaintenanceCommand[];
}

export interface RestorePlan {
  readonly steps: readonly RestorePlanStep[];
  readonly safetySet: boolean;
  readonly targetState: TargetState;
  readonly custodian: CustodianTopology;
  /**
   * The digest a confirmation has to carry back.
   *
   * OVER WHAT WAS DECIDED, not over how it was printed: the set's own `setDigest` from the verification, the
   * declared custody, whether a safety set will be taken, and every step id with the exact argv of every
   * command it issues. A set that changed, a target that changed topology, or a step list that differs by one
   * argument all produce a different value — and a different value is a refusal with nothing destroyed.
   */
  readonly digest: string;
}

export function planCompleteRestore(resolved: ResolvedRestore, options: { readonly safetySet: boolean }): RestorePlan {
  const cwd = resolved.projectRoot;
  const compose = (args: readonly string[], purpose: string): MaintenanceCommand =>
    ({ program: 'docker', args: ['compose', ...args], cwd, purpose });

  const ids = stepsFor({
    custodian: resolved.custodian,
    safetySet: options.safetySet,
    promotionRecords: resolved.promotionRecordsDir !== null,
  });

  const commandsFor = (id: RestoreStepId): readonly MaintenanceCommand[] => {
    switch (id) {
      case 'stop-and-destroy':
        // `down -v`, AND THE `-v` IS THE POINT. A dump replays into an EMPTY database; replaying it over a
        // schema that is already there produces conflicts, not a rollback. In inline custody the same
        // teardown empties the keystore volume, which is what makes the placement afterwards a placement and
        // never a merge of two moments' key material.
        return [compose(['down', '-v'], 'stop the stack and destroy its volumes')];
      case 'database-up':
        return [compose(
          ['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', String(DATABASE_WAIT_SECONDS), 'postgres'],
          'start only the database, from an image already on this host, and wait for its declared healthcheck')];
      case 'prepare-runtime-role':
        return [compose(
          ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'catalog', '-v', 'ON_ERROR_STOP=1',
            '-c', prepareRuntimeRoleSql()],
          'prepare the credential-free managed runtime role the dump\'s grants land on')];
      case 'replay-database':
        return [compose(
          ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'catalog', '-v', 'ON_ERROR_STOP=1'],
          'replay the verified dump from this command\'s own descriptor')];
      case 'place-inline-keystore':
        return [
          compose(['create', '--pull', 'never', 'app'],
            'create the app container the keystore is copied into, without starting it'),
          compose(['cp', `${join(resolved.setDir, COMPONENT_ARTIFACT_NAMES.keystore)}${SEPARATOR_FOR_CP}`,
            `app:${INLINE_KEYSTORE_CONTAINER_PATH}`],
          'copy the set\'s keystore into the volume the teardown emptied'),
        ];
      case 'stack-up':
        return [compose(
          ['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', String(STACK_WAIT_SECONDS)],
          'start the whole stack and wait for its declared healthchecks')];
      case 'prove-version':
        return [compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:version'],
          'read the build and database schema versions out of the running installation')];
      case 'prove-doctor':
        return [compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:doctor', '--', '--json'],
          'run the shipped read-only doctor')];
      case 'prove-decrypt':
        return [compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:collections', '--', 'status'],
          'read the catalog through a shipped primitive that must DECRYPT to answer')];
      case 'prove-history':
        return [compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:collections', '--', 'history'],
          'read the durable, identity-minimised history')];
      default:
        // The safety set and the three swaps issue no command of their own: the safety set is Phase 277's
        // whole cycle, and a swap is two renames on this host.
        return [];
    }
  };

  const steps = ids.map((id): RestorePlanStep => ({
    id,
    proves: RESTORE_STEP_PURPOSE[id],
    destructive: DESTRUCTIVE_STEP_IDS.includes(id),
    commands: commandsFor(id),
  }));

  const canonical = JSON.stringify([
    COMPLETE_RESTORE_REPORT,
    COMPLETE_RESTORE_VERSION,
    resolved.setName,
    resolved.verification.setDigest,
    resolved.custodian,
    options.safetySet,
    steps.map((step) => [step.id, step.commands.map((command) => [command.program, ...command.args])]),
  ]);
  return {
    steps,
    safetySet: options.safetySet,
    targetState: resolved.targetState,
    custodian: resolved.custodian,
    digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  };
}

/**
 * The separator `compose cp` needs to copy a directory's CONTENTS rather than the directory itself.
 *
 * `cp ./keystore-backup/. app:/…/keystore` is the form `backup-components.ts` has always documented, and it
 * is a forward slash on every platform because it is a Docker CLI argument, not a host path component.
 */
const SEPARATOR_FOR_CP = '/.';

/**
 * The one statement that creates the managed runtime role.
 *
 * `pg_dump` preserves GRANT targets and does NOT dump cluster-wide roles, so the role the restored ACLs land
 * on has to exist first. It is a product constant rather than input from the dump, it is created WITHOUT a
 * login — `CREATE ROLE` defaults to NOLOGIN — and it carries no credential; the normal bootstrap sets its
 * password from the restored secret afterwards. Only `CREATE ROLE` is spelled, so the maintenance command
 * vocabulary contains no registry "login" token and the no-network ledger stays mechanically checkable.
 */
export function prepareRuntimeRoleSql(): string {
  return 'DO $catalog$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '
    + `'${RUNTIME_ROLE_NAME}') THEN CREATE ROLE ${RUNTIME_ROLE_NAME}; END IF; END $catalog$;`;
}

// -----------------------------------------------------------------------------------------------------------
// The journal
// -----------------------------------------------------------------------------------------------------------

export interface RestoreJournal {
  readonly journal: 'catalog-authority.restore';
  readonly version: typeof RESTORE_JOURNAL_VERSION;
  readonly planDigest: string;
  readonly setName: string;
  readonly custodian: CustodianTopology;
  /** The swap suffix this run chose. `--abandon` finds the replaced directories by it. */
  readonly suffix: string;
  readonly safetySetName: string | null;
  /** Step ids that completed, in order. A step that started and did not complete is simply not here. */
  readonly completed: readonly RestoreStepId[];
  /** The step that was running when the journal was last written, or `null` between steps. */
  readonly running: RestoreStepId | null;
}

export function journalPath(projectRoot: string): string {
  return join(projectRoot, RESTORE_JOURNAL_NAME);
}

/**
 * Read a journal, or answer `null` when there is none.
 *
 * OPENED THE SAME WAY EVERY OTHER FILE IN THIS FAMILY IS: without following a link, bounded, and refused
 * rather than guessed at when it is not a journal this build understands. A file at that name that is not
 * ours is a refusal, not an absence — treating it as an absence would let anything sitting at that path
 * silently authorise a fresh destructive run.
 */
export function readRestoreJournal(projectRoot: string): RestoreJournal | null {
  const path = journalPath(projectRoot);
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return null;
  const raw = readFileNoFollow(path, 'restore journal', MAX_JOURNAL_BYTES).bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MaintenanceRefused(
      'this project holds a restore journal that is not readable JSON. A restore was interrupted here, or '
      + 'something else is using that name. Nothing was changed — look at it before running anything.');
  }
  const doc = parsed as Partial<RestoreJournal>;
  if (doc.journal !== 'catalog-authority.restore' || doc.version !== RESTORE_JOURNAL_VERSION
    || typeof doc.planDigest !== 'string' || typeof doc.setName !== 'string' || typeof doc.suffix !== 'string'
    || !Array.isArray(doc.completed) || (doc.custodian !== 'inline' && doc.custodian !== 'sidecar')) {
    throw new MaintenanceRefused(
      'this project holds a restore journal this build does not understand. Nothing was changed.');
  }
  return doc as RestoreJournal;
}

/**
 * Write the journal, replacing whatever it said before.
 *
 * A NEW FILE AND A RENAME, EVERY TIME. `writePrivateFile` is `O_EXCL` on purpose — nothing in this family
 * writes into a name it did not create — so an update stages a uniquely named private file beside the journal
 * and renames it over the top. The rename is what makes a journal read by anything else either the previous
 * complete one or the new complete one, never a prefix of either.
 */
export function writeRestoreJournal(projectRoot: string, journal: RestoreJournal): void {
  const staging = join(projectRoot, `${RESTORE_JOURNAL_NAME}.writing-${stagingSuffix()}`);
  writePrivateFile(staging, `${JSON.stringify(journal, null, 2)}\n`, 'restore journal');
  try {
    renameSync(staging, journalPath(projectRoot));
  } catch {
    throw new MaintenanceRefused('the restore journal could not be written, so this run stopped before it acted');
  }
}

/**
 * Remove the journal, if it is one of ours. Used by a completed run and by `--abandon`.
 *
 * IT READS IT FIRST, AND THAT IS THE OWNERSHIP PROOF. `readRestoreJournal` refuses a file at that name this
 * build does not understand, so the `unlink` below can only ever reach a journal this product wrote — the
 * same rule `removeOwnFileNoFollow` states with a digest, established here by the parse that has to succeed.
 * This is the ONLY removal in this module: every other operation is a rename.
 */
export function clearRestoreJournal(projectRoot: string): void {
  const path = journalPath(projectRoot);
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return;
  readRestoreJournal(projectRoot);
  try {
    unlinkSync(path);
  } catch {
    throw new MaintenanceRefused('the restore journal could not be removed. The restore itself is unaffected.');
  }
}

// -----------------------------------------------------------------------------------------------------------
// Running it
// -----------------------------------------------------------------------------------------------------------

export interface CompleteRestoreDeps {
  readonly runner: CommandRunner;
  /** The runner that binds the set's dump to the child's stdin. The replay is its only user. */
  readonly fileRunner: FileInputRunner;
  /**
   * The runner that binds a child's stdout to a file — Phase 277's, needed by the SAFETY SET's `pg_dump`.
   *
   * IT IS HERE RATHER THAN A WHOLE BACKUP FUNCTION BEING INJECTED, and that is deliberate. An injected
   * "take a backup" seam is a seam through which a caller — or a suite — could supply something that returns
   * `ok: true` without a set existing, which is exactly the false proof the safety set exists to prevent.
   * What is injected is a process runner; the backup itself is `runVerifiedCompleteBackup`, called by name.
   */
  readonly backupFileRunner: FileOutputRunner;
  readonly ledger: CommandLedger;
  /** Injected so a suite gets deterministic swap names. Never used for a decision. */
  readonly suffix?: () => string;
  /** Injected so a suite's safety set carries a fixed timestamp. Never used for a name or a decision. */
  readonly now?: () => Date;
}

export type RestoreMode =
  | { readonly kind: 'run'; readonly confirm: string; readonly acceptDataLoss: string | null }
  | { readonly kind: 'resume'; readonly confirm: string };

export interface RestoreStepResult {
  readonly id: RestoreStepId;
  readonly proves: string;
  /** `held` the step did what it says; `skipped` it was already done and recognised; `failed` it did not. */
  readonly outcome: 'held' | 'skipped' | 'failed';
  /** The closed-set sentence for a step that did not hold. Never interpolated with anything read at runtime. */
  readonly detail: string | null;
}

export interface CompleteRestoreReport {
  readonly report: typeof COMPLETE_RESTORE_REPORT;
  readonly version: typeof COMPLETE_RESTORE_VERSION;
  /** Every step held, every proof held, and the installation is back. Nothing weaker is `true`. */
  readonly ok: boolean;
  /** The state this run reached, as one of four words. */
  readonly state: 'RESTORED' | 'RESTORED_BUT_UNPROVEN' | 'INCOMPLETE' | 'REFUSED';
  readonly setName: string;
  readonly custodian: CustodianTopology;
  readonly targetState: TargetState;
  readonly planDigest: string;
  /** The safety set's name, or `null` when the run was told to take none. */
  readonly safetySet: string | null;
  readonly safetySetVerified: boolean;
  readonly steps: readonly RestoreStepResult[];
  /** The base names the previous host state was renamed to, so an operator can find and destroy them. */
  readonly replaced: readonly string[];
  readonly schemaVersion: number;
  readonly network: 'none';
  readonly mediaAccess: 'none';
  readonly notes: readonly string[];
}

/**
 * A restore that failed WITH the second fact when there is one.
 *
 * The same shape `CompleteBackupFailed` has, for the same reason: when a step fails and the installation is
 * left stopped, an operator has two problems and the urgent one is the outage. The primary refusal is
 * preserved word for word and the outage is ADDED to it rather than substituted for it.
 */
export class CompleteRestoreFailed extends MaintenanceRefused {
  readonly primary: string;
  readonly stateReached: RestoreStepId | null;

  constructor(primary: string, stateReached: RestoreStepId | null) {
    super(`${primary} THE INSTALLATION IS PART WAY THROUGH A RESTORE AND IS NOT RUNNING. A journal was left in `
      + 'the project: re-run with --resume to continue from this step, or --abandon to put the host directories '
      + 'back and start again from the safety set.');
    this.name = 'CompleteRestoreFailed';
    this.primary = primary;
    this.stateReached = stateReached;
  }
}

export function runCompleteRestore(
  request: CompleteRestoreRequest,
  deps: CompleteRestoreDeps,
  mode: RestoreMode,
): CompleteRestoreReport {
  const resolved = resolveCompleteRestoreRequest(request);
  const existing = readRestoreJournal(resolved.projectRoot);

  if (mode.kind === 'run' && existing !== null) {
    throw new MaintenanceRefused(
      'this project is part way through a restore: a journal is here from a run that did not finish. An '
      + 'installation half-way through a restore is not a starting point, and running from the top would take a '
      + '"safety set" of the wreckage. Continue it with --resume, or put the host directories back with '
      + '--abandon. Nothing was changed.');
  }
  if (mode.kind === 'resume' && existing === null) {
    throw new MaintenanceRefused(
      'there is no restore to resume in this project: no journal is here. Nothing was changed.');
  }

  // A RESUMED RUN INHERITS THE SHAPE IT WAS INTERRUPTED IN. Whether a safety set was taken is a fact about
  // the run that already happened; recomputing it from the target's CURRENT state would answer EMPTY on an
  // installation this run itself emptied, which would change the plan and therefore the digest.
  const safetySet = existing !== null
    ? existing.safetySetName !== null
    : resolved.targetState === 'OCCUPIED' && mode.kind === 'run' && mode.acceptDataLoss === null;
  const plan = planCompleteRestore(resolved, { safetySet });

  if (mode.confirm !== plan.digest) {
    throw new MaintenanceRefused(
      'the confirmation does not match this plan\'s digest. Run --plan again, read what it would do, and pass the '
      + 'digest it prints. A digest computed for a different set, a different topology or a different step list '
      + 'is not a confirmation of THIS run, and nothing was changed.');
  }
  if (mode.kind === 'run' && mode.acceptDataLoss !== null) {
    if (resolved.targetState === 'EMPTY') {
      throw new MaintenanceRefused(
        'this installation has nothing to lose and a loss was acknowledged anyway. That acknowledgement is a habit '
        + 'somebody is building for the run where there IS something to lose, so it is refused here. Drop the flag.');
    }
    if (mode.acceptDataLoss !== plan.digest) {
      throw new MaintenanceRefused(
        'the acknowledgement of data loss does not carry this plan\'s digest, so it could have been pasted from '
        + 'another run, another set or another project. Nothing was changed.');
    }
  }
  if (existing !== null && existing.planDigest !== plan.digest) {
    throw new MaintenanceRefused(
      'the interrupted restore in this project was planned for something other than what this command just '
      + 'resolved. Resuming it under a different plan would apply half of one restore and half of another. '
      + 'Nothing was changed.');
  }

  const suffix = existing?.suffix ?? (deps.suffix ?? stagingSuffix)();
  const completed = new Set<RestoreStepId>(existing?.completed ?? []);
  const results: RestoreStepResult[] = [];
  const replaced: string[] = [];
  const notes: string[] = [];
  let safetySetName: string | null = existing?.safetySetName ?? null;
  let safetySetVerified = existing !== null && existing.safetySetName !== null;
  let stopped = false;
  let failedAt: RestoreStepId | null = null;
  let failure: string | null = null;

  // ONE MAINTENANCE COMMAND AT A TIME, PER PROJECT. The same lock `ops:complete-backup` takes, so a backup
  // and a restore of one installation cannot interleave — and the safety set below is taken INSIDE it.
  const lock = acquireMaintenanceLock(resolved.projectRoot);
  try {
    // THE DIGEST IS RE-PROVED UNDER THE LOCK, over a FRESH verification of the set. Everything above ran
    // outside the lock; this is the check that says the set is still the set and the plan is still the plan at
    // the moment the destructive steps begin.
    const reResolved = resolveCompleteRestoreRequest(request);
    const rePlan = planCompleteRestore(reResolved, { safetySet });
    if (rePlan.digest !== plan.digest) {
      throw new MaintenanceRefused(
        'the set or the installation changed between the plan and this run, so the plan no longer describes what '
        + 'would happen. Nothing was changed. Re-plan and read it again.');
    }

    writeRestoreJournal(resolved.projectRoot, {
      journal: 'catalog-authority.restore',
      version: RESTORE_JOURNAL_VERSION,
      planDigest: plan.digest,
      setName: resolved.setName,
      custodian: resolved.custodian,
      suffix,
      safetySetName,
      completed: [...completed],
      running: null,
    });

    for (const step of plan.steps) {
      if (completed.has(step.id)) {
        results.push({ id: step.id, proves: step.proves, outcome: 'skipped', detail: 'already completed by an earlier run' });
        continue;
      }
      journalRunning(resolved.projectRoot, plan.digest, resolved, suffix, safetySetName, completed, step.id);

      let detail: string | null;
      try {
        detail = performStep(step.id, resolved, plan, deps, suffix, {
          onSafetySet: (name, verified) => { safetySetName = name; safetySetVerified = verified; },
          onReplaced: (name) => { replaced.push(name); },
          onStopped: () => { stopped = true; },
        });
      } catch (err) {
        detail = err instanceof MaintenanceRefused
          ? err.message
          : 'this step failed for a reason this command does not have safe wording for';
      }

      if (detail !== null) {
        results.push({ id: step.id, proves: step.proves, outcome: 'failed', detail });
        failedAt = step.id;
        failure = detail;
        break;
      }
      completed.add(step.id);
      results.push({ id: step.id, proves: step.proves, outcome: 'held', detail: null });
      journalRunning(resolved.projectRoot, plan.digest, resolved, suffix, safetySetName, completed, null);
    }
  } finally {
    lock.release();
  }

  // ---- what state did this run actually reach ------------------------------------------------------
  const proofsRun = plan.steps.filter((step) => PROOF_STEP_IDS.includes(step.id)).map((step) => step.id);
  const everyStepHeld = failedAt === null;
  const proofsHeld = everyStepHeld && proofsRun.every((id) => completed.has(id));
  // A FAILURE INSIDE THE PROOFS IS NOT THE SAME AS A FAILURE BEFORE THEM. The installation IS restored and
  // running; what did not hold is the evidence that it is correct — and the difference decides what an
  // operator does next, so it is a different word rather than a note under one.
  const restoredButUnproven = failedAt !== null && PROOF_STEP_IDS.includes(failedAt);

  if (everyStepHeld) {
    clearRestoreJournal(resolved.projectRoot);
    notes.push('The journal has been cleared: this restore completed and this project is not part way through one.');
  } else {
    notes.push('A restore journal was left in this project. Continue with --resume, or put the host directories '
      + 'back with --abandon. This project refuses a fresh restore until one of those has run.');
  }
  if (safetySetName !== null) {
    notes.push('The safety set holds the installation as it was before this restore. Destroy it deliberately once '
      + 'you have confirmed this restore is the one you wanted.');
  } else {
    notes.push('NO SAFETY SET WAS TAKEN. The installation this restore replaced is not recoverable from anything '
      + 'this command produced.');
  }
  if (replaced.length > 0) {
    notes.push('The previous contents of the swapped directories are beside them under the names listed above. '
      + 'They hold secret material: destroy them the way you would destroy a password, once you are done.');
  }
  notes.push('Nothing was fetched and no media path was read.');

  const state: CompleteRestoreReport['state'] = everyStepHeld
    ? 'RESTORED'
    : restoredButUnproven ? 'RESTORED_BUT_UNPROVEN' : 'INCOMPLETE';

  const report: CompleteRestoreReport = {
    report: COMPLETE_RESTORE_REPORT,
    version: COMPLETE_RESTORE_VERSION,
    ok: everyStepHeld && proofsHeld,
    state,
    setName: resolved.setName,
    custodian: resolved.custodian,
    targetState: resolved.targetState,
    planDigest: plan.digest,
    safetySet: safetySetName,
    safetySetVerified,
    steps: results,
    replaced,
    schemaVersion: MIGRATION_VERSION,
    network: 'none',
    mediaAccess: 'none',
    notes,
  };

  // A FAILURE THAT LEFT THE INSTALLATION DOWN IS A THROW, NOT A REPORT WITH A FALSE `ok`.
  //
  // The distinction is the same one Phase 277 draws: a run that failed BEFORE the teardown has changed
  // nothing and is a plain refusal; a run that failed AFTER it has left services stopped, and an operator
  // must not have to read a report to discover that. The proofs are the exception — by then the stack is up.
  if (failure !== null && stopped && !restoredButUnproven) {
    throw new CompleteRestoreFailed(failure, failedAt);
  }
  return report;
}

/** Record which step is running, before it runs. The journal is the only thing `--resume` trusts. */
function journalRunning(
  projectRoot: string,
  planDigest: string,
  resolved: ResolvedRestore,
  suffix: string,
  safetySetName: string | null,
  completed: ReadonlySet<RestoreStepId>,
  running: RestoreStepId | null,
): void {
  writeRestoreJournal(projectRoot, {
    journal: 'catalog-authority.restore',
    version: RESTORE_JOURNAL_VERSION,
    planDigest,
    setName: resolved.setName,
    custodian: resolved.custodian,
    suffix,
    safetySetName,
    completed: [...completed],
    running,
  });
}

/**
 * Perform one step. Answers `null` when it held, or the closed sentence for why it did not.
 *
 * NOTHING HERE THROWS TO SIGNAL A STEP FAILING — a returned sentence is the signal, so every step's failure
 * travels the same way and reaches the report. A `MaintenanceRefused` thrown by a helper is caught by the
 * caller and becomes the same thing.
 */
function performStep(
  id: RestoreStepId,
  resolved: ResolvedRestore,
  plan: RestorePlan,
  deps: CompleteRestoreDeps,
  suffix: string,
  hooks: {
    readonly onSafetySet: (name: string, verified: boolean) => void;
    readonly onReplaced: (name: string) => void;
    readonly onStopped: () => void;
  },
): string | null {
  const step = plan.steps.find((candidate) => candidate.id === id)!;
  const runOne = (command: MaintenanceCommand): CommandOutcome => runGuarded(deps.runner, deps.ledger, command);

  switch (id) {
    case 'safety-set': {
      // PHASE 277'S WHOLE CYCLE, CALLED BY NAME AND UNCHANGED. `ok` there is the conjunction of the set being
      // taken, the stack coming back AND the set verifying, and nothing weaker is accepted here.
      //
      // `holdingLock` is why this is one line rather than a lock dance: this run already holds the project's
      // maintenance lock and `mkdir` as a lock is not reentrant. The exclusion property is unchanged — the
      // lock is held for the whole of this backup, by the restore.
      let outcome: CompleteBackupOutcome;
      try {
        outcome = runVerifiedCompleteBackup({
          projectRoot: resolved.projectRoot,
          destination: resolved.destination,
          setName: resolved.safetySetName,
          custodian: resolved.custodian,
          secrets: resolved.secretsRelative,
          ...(resolved.sidecarStateRelative === null ? {} : { sidecarState: resolved.sidecarStateRelative }),
          ...(resolved.promotionRecordsRelative === null
            ? {}
            : { promotionRecords: resolved.promotionRecordsRelative }),
        }, {
          runner: deps.runner,
          fileRunner: deps.backupFileRunner,
          ledger: deps.ledger,
          holdingLock: true,
          ...(deps.now === undefined ? {} : { now: deps.now }),
        });
      } catch (err) {
        hooks.onSafetySet(resolved.safetySetName, false);
        // THE BACKUP'S OWN WORDS, WHICH THIS PRODUCT WROTE. Anything else becomes a fixed sentence, because a
        // foreign error's message routinely carries the absolute path it failed on.
        return err instanceof MaintenanceRefused
          ? `${err.message} Nothing was destroyed.`
          : 'a verified safety set could not be taken, for a reason this command does not have safe wording for. '
            + 'Nothing was destroyed.';
      }
      hooks.onSafetySet(resolved.safetySetName, outcome.ok);
      if (!outcome.ok) {
        return 'a verified safety set could not be taken of the installation this restore would destroy, so '
          + 'nothing was destroyed. Fix what the backup reported first.';
      }
      return null;
    }
    case 'stop-and-destroy': {
      hooks.onStopped();
      const outcome = runOne(step.commands[0]!);
      return outcome.status === 0 ? null : 'the stack could not be stopped and its volumes destroyed';
    }
    case 'place-secrets':
      return swapComponent(resolved.secretsDir, resolved.secretsName, resolved.setDir, 'secrets', suffix,
        'secrets directory', hooks.onReplaced);
    case 'place-promotion-records':
      return swapComponent(resolved.promotionRecordsDir!, resolved.promotionRecordsName!, resolved.setDir,
        'promotion-records', suffix, 'promotion records directory', hooks.onReplaced);
    case 'place-sidecar-keystore':
      return swapComponent(resolved.sidecarStateDir!, resolved.sidecarStateName!, resolved.setDir,
        'keystore', suffix, 'sidecar state directory', hooks.onReplaced);
    case 'replay-database': {
      const dump = join(resolved.setDir, COMPONENT_ARTIFACT_NAMES.database);
      const outcome = runGuardedFromFile(deps.fileRunner, deps.ledger, step.commands[0]!, dump);
      return outcome.status === 0 ? null : 'the verified dump did not replay into the fresh database';
    }
    case 'prove-version': {
      const outcome = runOne(step.commands[0]!);
      const read = readSchemaVersions(outcome.stdout);
      if (read === null) return 'the schema version could not be read out of the running installation';
      if (read.build !== read.database) {
        return 'the running build and the restored database are at different schema versions, which means the '
          + 'image this project pins is not the build this set was taken from';
      }
      if (read.database !== resolved.verification.manifestSchemaVersion) {
        return 'the restored database is not at the schema version this set recorded, so what is running is not '
          + 'the moment this set captured';
      }
      // A MATCHING BODY BEHIND A FAILED PROCESS IS A CONTRADICTION. `ops:version` exits non-zero exactly when
      // the build and the database disagree, so numbers that agree over a non-zero exit are two answers.
      return outcome.status === 0
        ? null
        : 'the schema versions printed agree and the command did not succeed, which do not agree';
    }
    case 'prove-doctor': {
      const outcome = runOne(step.commands[0]!);
      const parsed = parseDoctorJson(outcome.stdout);
      if (parsed === null) {
        return outcome.status === 0
          ? 'the doctor did not answer in the shape this build understands'
          : 'the doctor did not succeed, whatever it printed';
      }
      // THE STATE, WHICH IS ONE OF FOUR WORDS, and never a `detail`: a doctor detail is written for a person
      // at a terminal and can name a path, a uid or a connection.
      const state = classifyDoctor(parsed);
      if (state === 'FAIL' || state === 'INVALID') return `the doctor reported ${state} on the restored installation`;
      return outcome.status === 0
        ? null
        : 'the doctor printed a healthy report and did not succeed, which do not agree';
    }
    default: {
      // Every remaining step is "run the commands and require zero", which covers the two `up`s, the role
      // preparation, the inline keystore placement and the two remaining proofs.
      for (const command of step.commands) {
        const outcome = runOne(command);
        if (outcome.status !== 0) return failureSentence(id);
      }
      return null;
    }
  }
}

/** The closed sentence for a step whose process did not succeed, named for what the step was asking. */
export function failureSentence(id: RestoreStepId): string {
  switch (id) {
    case 'database-up': return 'a fresh database did not become healthy from an image already on this host';
    case 'prepare-runtime-role': return 'the credential-free managed runtime role could not be prepared';
    case 'place-inline-keystore': return 'the set\'s keystore could not be placed in the app container\'s volume';
    case 'stack-up': return 'the restored stack did not start and become healthy';
    case 'prove-decrypt': return 'the installation could not read and DECRYPT its own catalog, which is what a '
      + 'keystore that did not arrive looks like';
    case 'prove-history': return 'the durable history could not be read out of the restored installation';
    default: return 'this step did not succeed';
  }
}

/**
 * Put one component's copy where the installation reads it, by RENAME rather than by writing over anything.
 *
 * THE ORDER IS THE GUARANTEE, and every one of the four operations is chosen for what a kill in the middle of
 * it leaves:
 *
 *   1. The set's copy is staged beside the target under a dot-prefixed name. A kill here leaves a staging
 *      directory and an UNTOUCHED target.
 *   2. The target, if there is one, is renamed to `.<name>.replaced-<suffix>`. A kill here leaves no target —
 *      visible, named, and exactly what `--abandon` puts back.
 *   3. The staged copy is renamed into place.
 *   4. Nothing is deleted. The previous state stays on disk under a name this command chose, because deleting
 *      the only copy of an operator's secrets to tidy up would be the worst kind of helpfulness.
 *
 * AND IT IS IDEMPOTENT, WHICH IS WHAT MAKES `--resume` SAFE. A target that already holds exactly what this
 * set would put there — by the digest algorithm the backup itself uses, not a second one — is recognised and
 * SKIPPED. Swapping a second time would rename the RESTORED state aside and record it as the previous one.
 */
function swapComponent(
  targetDir: string,
  targetName: string,
  setDir: string,
  id: BackupComponentId,
  suffix: string,
  what: string,
  onReplaced: (name: string) => void,
): string | null {
  const source = join(setDir, COMPONENT_ARTIFACT_NAMES[id]);
  const expected = digestTreeAt(source, `${what} in the set`);

  if (existsSync(targetDir)) {
    const stats = lstatSync(targetDir);
    if (stats.isSymbolicLink()) return `the ${what} is a symbolic link, which this command will not write through`;
    if (!stats.isDirectory()) return `the ${what} is not a directory`;
    // ALREADY THERE, AND PROVED SO. Never "it exists, so it is probably done".
    if (digestTreeAt(targetDir, what).digest === expected.digest) return null;
  }

  const parent = join(targetDir, '..');
  const staging = join(parent, swapStagingName(targetName, suffix));
  const replaced = join(parent, swapReplacedName(targetName, suffix));
  if (existsSync(staging) || existsSync(replaced)) {
    return `a previous attempt left a staging or replaced ${what} beside this one. Look at them before running `
      + 'again: this command will not write into a name it did not just create.';
  }

  copyTree(source, staging, what);
  if (existsSync(targetDir)) {
    try {
      renameSync(targetDir, replaced);
    } catch {
      return `the existing ${what} could not be moved aside, so nothing was replaced`;
    }
    onReplaced(swapReplacedName(targetName, suffix));
  }
  try {
    renameSync(staging, targetDir);
  } catch {
    return `the ${what} from this set could not be moved into place. The previous one is beside it under the `
      + 'replaced name and this run stopped.';
  }
  return null;
}

// -----------------------------------------------------------------------------------------------------------
// Abandoning one
// -----------------------------------------------------------------------------------------------------------

export interface AbandonReport {
  readonly report: 'phase-303-restore-abandon';
  readonly ok: boolean;
  readonly setName: string;
  /** The base names put back. Base names, never paths. */
  readonly restored: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Put the swapped host directories back, and clear the journal.
 *
 * IT RESTORES HOST STATE ONLY, AND IT SAYS SO. The database and, in inline custody, the keystore were
 * destroyed by `docker compose down -v`, and a rename cannot bring either of them back. What does is the
 * SAFETY SET, through this same command — and pretending otherwise would be the single most dangerous
 * sentence this product could print.
 */
export function abandonRestore(request: CompleteRestoreRequest, deps: { readonly ledger: CommandLedger }): AbandonReport {
  const projectRoot = resolveMaintenanceRoot(request.projectRoot, 'project root');
  const journal = readRestoreJournal(projectRoot);
  if (journal === null) {
    throw new MaintenanceRefused('there is no restore to abandon in this project: no journal is here.');
  }
  void deps;

  const restored: string[] = [];
  const notes: string[] = [];
  // Resolved WITHOUT the set: abandoning must work when the set has been moved away, which is exactly the
  // situation somebody is in when they decide to abandon.
  const targets: { readonly dir: string; readonly name: string }[] = [];
  const add = (relative: string | undefined): void => {
    if (relative === undefined || relative.trim() === '') return;
    targets.push({ dir: resolveInsideRoot(projectRoot, relative, 'directory'), name: lastSegment(relative) });
  };
  add(request.secrets);
  add(request.promotionRecords);
  add(request.sidecarState);

  for (const target of targets) {
    const parent = join(target.dir, '..');
    const replaced = join(parent, swapReplacedName(target.name, journal.suffix));
    if (!existsSync(replaced)) continue;
    if (lstatSync(replaced).isSymbolicLink() || !statSync(replaced).isDirectory()) {
      throw new MaintenanceRefused(
        'what this run moved aside is no longer a plain directory, so it was left alone. Nothing was changed.');
    }
    // THE RESTORED COPY IS MOVED ASIDE, NOT DELETED. Same rule as the swap: this command does not destroy the
    // only copy of anything, and an operator who abandons and then changes their mind still has both.
    if (existsSync(target.dir)) {
      const aside = join(parent, `.${target.name}.abandoned-${journal.suffix}`);
      if (existsSync(aside)) {
        throw new MaintenanceRefused(
          'an abandoned copy of this directory is already beside it from an earlier attempt. Look at it first: '
          + 'this command will not write into a name it did not just create. Nothing was changed.');
      }
      renameSync(target.dir, aside);
    }
    renameSync(replaced, target.dir);
    restored.push(target.name);
  }

  clearRestoreJournal(projectRoot);
  notes.push('The host directories this restore swapped are back where they were. THE DATABASE AND, IN INLINE '
    + 'CUSTODY, THE KEYSTORE WERE DESTROYED BY THE TEARDOWN AND ARE NOT COMING BACK FROM A RENAME. Restore the '
    + 'safety set to get them.');
  notes.push('The journal has been cleared, so this project accepts a restore again.');
  return { report: 'phase-303-restore-abandon', ok: true, setName: journal.setName, restored, notes };
}

// -----------------------------------------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------------------------------------

/** The human summary. Step ids, closed verdicts, base names and counts. Never a path, never a component. */
export function renderCompleteRestore(report: CompleteRestoreReport): string {
  const lines: string[] = [];
  lines.push(`Complete restore — ${report.state}`);
  lines.push(`  set                ${report.setName}`);
  lines.push(`  custody            ${report.custodian}`);
  lines.push(`  target before      ${report.targetState}`);
  lines.push(`  plan digest        ${report.planDigest.slice(0, 16)}`);
  lines.push(`  safety set         ${report.safetySet ?? 'NONE TAKEN'}`
    + `${report.safetySet === null ? '' : ` (verified: ${report.safetySetVerified})`}`);
  lines.push(`  schema version     ${report.schemaVersion}`);
  lines.push('  steps:');
  for (const step of report.steps) {
    lines.push(`    ${step.id.padEnd(24)} ${step.outcome.toUpperCase().padEnd(8)} ${step.proves}`);
    if (step.detail !== null && step.outcome === 'failed') lines.push(`      ${step.detail}`);
  }
  if (report.replaced.length > 0) {
    lines.push(`  previous state kept as: ${report.replaced.join(', ')}`);
  }
  lines.push(`  network            ${report.network}`);
  lines.push(`  media access       ${report.mediaAccess}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${report.ok ? 'RESTORED AND PROVED' : report.state}`);
  return lines.join('\n');
}

/** `--plan`'s rendering: the ordered steps and the digest a confirmation has to carry back. */
export function renderRestorePlan(resolved: ResolvedRestore, plan: RestorePlan): string {
  const lines: string[] = [];
  lines.push(`This restore would put set "${resolved.setName}" back, with no shell involved:`);
  lines.push(`  the installation it would restore into is ${plan.targetState}`);
  lines.push(`  custody is ${plan.custodian}, which the set's own manifest agrees with`);
  lines.push(plan.safetySet
    ? `  a verified safety set would be taken first, named "${resolved.safetySetName}"`
    : '  NO SAFETY SET WOULD BE TAKEN');
  lines.push('');
  for (const step of plan.steps) {
    lines.push(`  ${step.destructive ? '!' : ' '} ${step.id}`);
    lines.push(`      ${step.proves}`);
    for (const command of step.commands) {
      lines.push(`      ${command.program} ${command.args.join(' ')}`);
    }
  }
  lines.push('');
  lines.push('  ! marks a step after which this installation is not where it was.');
  lines.push('  Components are placed by RENAME: the previous directory is kept beside the new one.');
  lines.push('  Nothing would be fetched and no media path would be read.');
  lines.push('');
  lines.push(`  plan digest: ${plan.digest}`);
  lines.push('  Pass that digest back with --confirm to run this. Nothing has been changed.');
  return lines.join('\n');
}

/** The last path segment of an operator-supplied relative path. A name, never a path. */
function lastSegment(relative: string): string {
  const parts = relative.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
  const last = parts[parts.length - 1];
  if (last === undefined) {
    throw new MaintenanceRefused('a directory was named by a path with no final segment, which names nothing');
  }
  return last;
}
