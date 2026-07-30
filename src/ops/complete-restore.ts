import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative as relativePath } from 'node:path';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import { RUNTIME_ROLE_NAME } from './bootstrap.js';
import {
  BACKUP_COMPONENT_IDS,
  COMPONENT_ARTIFACT_NAMES,
  type BackupComponentId,
} from './backup-components.js';
import {
  copyTree,
  digestTreeAt,
  readBackupManifest,
  runVerifiedCompleteBackup,
  type BackupManifest,
  type CompleteBackupOutcome,
} from './complete-backup.js';
import { verifyBackupSet, type BackupVerificationReport } from './backup-set-verification.js';
import { classifyDoctor, parseDoctorJson } from './doctor-monitor.js';
import { readCustodyProof, type CustodyProofReport } from './custody-proof.js';
import { readSchemaVersions } from './upgrade-rehearsal.js';
import {
  RESTORE_STEP_IDS,
  RESTORE_STEP_PURPOSE,
  RESTORE_SUFFIX_RE,
  DESTRUCTIVE_STEP_IDS,
  PROOF_STEP_IDS,
  STAGED_TOKEN,
  requiredPlacementIds,
  stagedPath,
  stagingDirName,
  stepsFor,
  swapReplacedName,
  swapStagingName,
  type CustodianTopology,
  type RestoreStepId,
} from './restore-model.js';
import {
  MAINTENANCE_NAME_RE,
  MaintenanceRefused,
  acquireMaintenanceLock,
  assertPlainTree,
  assertUsableName,
  copyFileNoFollow,
  createPrivateDirectory,
  digestFileNoFollow,
  readFileNoFollow,
  removeOwnTreeNoFollow,
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
// before a dump is replayed into it.
//
// THIS COMPOSES, IT DOES NOT REDEFINE. The component list is `backup-components.ts`'s. The placements are
// `restore-model.ts`'s. The set is verified by Phase 278's `verifyBackupSet`. The safety set is Phase 277's
// own `runVerifiedCompleteBackup`, called by name. The decryption proof is Phase 302's `ops:custody-proof`,
// which decrypts through the shipped catalog authority.
//
// -----------------------------------------------------------------------------------------------------
// WHAT THE FIRST CUT GOT WRONG, AND WHAT EACH CORRECTION IS.
// -----------------------------------------------------------------------------------------------------
//
//   * A CONFIRMATION BOUND ONLY PART OF WHAT IT AUTHORISED. The digest covered the set, the topology and the
//     step list — but not WHICH PROJECT, which destination, which target directories, which safety-set name
//     or what this command believed about the installation it was about to destroy. A digest read off one
//     project's plan authorised the same-shaped operation against another. It now binds a canonical
//     OPERATION IDENTITY, and every one of those is in it.
//
//   * "EMPTY" WAS INFERRED FROM EMPTY HOST DIRECTORIES. `docker compose down -v` destroys VOLUMES, and a
//     project whose host directories are empty can still have a populated database volume and a populated
//     keystore volume. There is no way to read a volume's contents without starting something, and starting
//     something is a mutation. So emptiness is never inferred: a target is OCCUPIED or UNKNOWN, both require
//     authorisation, and the only way past is the digest-bound acknowledgement of data loss.
//
//   * THE SET COULD CHANGE AFTER IT WAS VERIFIED. Every placement re-opened the set by path. Components are
//     now STAGED and re-verified against the manifest before anything is destroyed, and the staged object is
//     what gets placed.
//
//   * THE JOURNAL WAS TRUSTED AND WAS NOT PATH-BOUND. It is now a validated state machine that carries its
//     own targets, so `--abandon` unwinds the operation that actually ran rather than whatever flags the
//     operator happens to type next.
//
//   * AND THE DECRYPTION PROOF DID NOT DECRYPT. See `custody-proof.ts`.

export const COMPLETE_RESTORE_REPORT = 'phase-297-304-complete-restore';
export const COMPLETE_RESTORE_VERSION = 2;

/** The journal a run in progress leaves in the project root. Private, and refused by a second run. */
export const RESTORE_JOURNAL_NAME = '.catalog-restore.journal.json';
export const RESTORE_JOURNAL_VERSION = 2;
/** A journal is small by construction. A file at that name larger than this is not one of ours. */
export const MAX_JOURNAL_BYTES = 64 * 1024;

/** Where the keystore lands inside the app container, in inline custody. Fixed by this project's images. */
export const INLINE_KEYSTORE_CONTAINER_PATH = '/var/lib/catalog/keystore';

/** How long the two `up` steps wait for their declared healthchecks, in seconds. */
export const DATABASE_WAIT_SECONDS = 60;
export const STACK_WAIT_SECONDS = 120;

/** What a rendered command shows where the project root is. No absolute host path reaches an output. */
export const PROJECT_TOKEN = '<project>';

// -----------------------------------------------------------------------------------------------------------
// The request, and what resolving it proves
// -----------------------------------------------------------------------------------------------------------

export interface CompleteRestoreRequest {
  readonly projectRoot: string;
  readonly destination: string;
  readonly setName: string;
  readonly custodian: CustodianTopology;
  readonly sidecarState?: string;
  readonly promotionRecords?: string;
  readonly secrets: string;
  readonly safetySetName?: string;
}

/**
 * What this command was able to establish about the installation it would restore into.
 *
 * -----------------------------------------------------------------------------------------------------
 * THERE IS NO `EMPTY`, AND ITS ABSENCE IS THE CORRECTION.
 * -----------------------------------------------------------------------------------------------------
 *
 * The first cut classified a project with empty host directories as EMPTY and skipped the safety set on the
 * strength of it. But the components this restore destroys are not all on the host: `docker compose down -v`
 * destroys the DATABASE VOLUME and, in inline custody, the KEYSTORE VOLUME. A project can have an empty
 * `secrets/` directory and a volume holding an entire catalog — that is precisely the state of an
 * installation whose host files were lost and whose Docker state was not.
 *
 * Reading a volume's contents means starting a container against it, and starting something is a mutation
 * this command must not perform before it has been authorised. So emptiness is NEVER INFERRED:
 *
 *   * `OCCUPIED` — positive evidence of state. Host component directories hold something, or the project has
 *     containers, or a probe could not answer. A verified safety set is mandatory.
 *   * `UNKNOWN` — no positive evidence either way, and no way to get any without mutating. A safety set
 *     cannot be taken (there is nothing on the host to back up), so the ONLY way past is the digest-bound
 *     acknowledgement of data loss.
 *
 * Both states require authorisation. Nothing is destroyed on the strength of a guess.
 */
export type TargetState = 'OCCUPIED' | 'UNKNOWN';

/** One resolved placement target: the operator's own relative string, the proved path, and the leaf name. */
export interface ResolvedTarget {
  readonly relative: string;
  readonly dir: string;
  readonly name: string;
}

export interface ResolvedRestore {
  readonly projectRoot: string;
  readonly setDir: string;
  readonly setName: string;
  readonly destination: string;
  readonly custodian: CustodianTopology;
  readonly secrets: ResolvedTarget;
  readonly promotionRecords: ResolvedTarget | null;
  readonly sidecarState: ResolvedTarget | null;
  readonly safetySetName: string;
  readonly present: readonly BackupComponentId[];
  readonly targetState: TargetState;
  readonly verification: BackupVerificationReport;
  readonly manifest: BackupManifest;
}

/** A probe of the project's container state. Non-mutating; `compose ps` starts nothing. */
export type OccupancyProbe = (projectRoot: string) => 'containers' | 'none' | 'unanswerable';

export function resolveCompleteRestoreRequest(
  request: CompleteRestoreRequest,
  probe?: OccupancyProbe,
): ResolvedRestore {
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
  let sidecarState: ResolvedTarget | null = null;
  if (request.custodian === 'sidecar') {
    if (request.sidecarState === undefined || request.sidecarState.trim() === '') {
      throw new MaintenanceRefused(
        'sidecar custody was declared but no sidecar state directory was given. This command will not guess where '
        + 'the keystore goes: a restore that placed it in the wrong directory would look complete and leave an '
        + 'installation that can decrypt nothing.');
    }
    sidecarState = resolveTarget(projectRoot, request.sidecarState, 'sidecar state directory');
  } else if (request.sidecarState !== undefined) {
    throw new MaintenanceRefused(
      'a sidecar state directory was given with inline custody. One of the two is wrong, and this command will not '
      + 'choose which.');
  }

  const secrets = resolveTarget(projectRoot, request.secrets, 'secrets directory');

  let promotionRecords: ResolvedTarget | null = null;
  if (present.includes('promotion-records')) {
    if (request.promotionRecords === undefined || request.promotionRecords.trim() === '') {
      throw new MaintenanceRefused(
        'this set carries promotion record artifacts and no promotion-records directory was given, so there is '
        + 'nowhere to put them. Name one, or take a set without them. This command will not silently drop a '
        + 'component it was handed — those files are the operator\'s own and this product cannot recreate them.');
    }
    promotionRecords = resolveTarget(projectRoot, request.promotionRecords, 'promotion records directory');
  }

  // ---- 4. EVERY TARGET IS DISTINCT -----------------------------------------------------------------
  //
  // TWO COMPONENTS AT ONE PATH IS A RESTORE THAT DESTROYS ONE OF THEM. The second swap would rename the FIRST
  // component's freshly restored directory aside and record it as "the previous contents".
  const targets = [secrets, promotionRecords, sidecarState].filter((target): target is ResolvedTarget => target !== null);
  for (let i = 0; i < targets.length; i += 1) {
    for (let j = i + 1; j < targets.length; j += 1) {
      if (targets[i]!.dir === targets[j]!.dir) {
        throw new MaintenanceRefused(
          'two components were pointed at the same directory. Restoring both would put one on top of the other '
          + 'and record the first one as the previous contents of the second. Nothing was changed.');
      }
    }
  }

  return {
    projectRoot,
    setDir,
    setName: request.setName,
    destination: request.destination,
    custodian: request.custodian,
    secrets,
    promotionRecords,
    sidecarState,
    safetySetName,
    present,
    targetState: classifyTarget(projectRoot, targets, probe),
    verification,
    manifest,
  };
}

/** Resolve one operator-supplied relative directory into a proved target. */
function resolveTarget(projectRoot: string, relative: string, what: string): ResolvedTarget {
  const dir = resolveInsideRoot(projectRoot, relative, what);
  if (existsSync(dir)) assertPlainTree(dir, what);
  const name = lastSegment(relative);
  // THE LEAF NAME IS CONCATENATED INTO `.<name>.replaced-<suffix>`, so it is held to the same shape every
  // other name this command creates is held to. A leaf carrying a dot-prefix or a separator would produce a
  // sibling nobody chose.
  assertUsableName(name, `${what} name`);
  return { relative, dir, name };
}

/**
 * What this command can establish about the installation it would restore into, without mutating it.
 *
 * THE PROBE IS `docker compose ps`, WHICH STARTS NOTHING. A project with containers has been up, and a
 * project that has been up has volumes with state in them — so containers are POSITIVE evidence of occupancy
 * that empty host directories cannot contradict. A probe that cannot answer is treated as occupancy, because
 * "I could not see it" is not "it is not there".
 *
 * AND THE ABSENCE OF CONTAINERS PROVES NOTHING. `docker compose down` removes containers and KEEPS volumes,
 * so a project with no containers and a full database volume is an ordinary state. That is why the other
 * answer is UNKNOWN and not EMPTY.
 */
export function classifyTarget(
  projectRoot: string,
  targets: readonly ResolvedTarget[],
  probe?: OccupancyProbe,
): TargetState {
  for (const target of targets) {
    const stats = lstatSync(target.dir, { throwIfNoEntry: false });
    if (stats === undefined) continue;
    if (!stats.isDirectory()) return 'OCCUPIED';
    try {
      if (readdirSync(target.dir).length > 0) return 'OCCUPIED';
    } catch {
      return 'OCCUPIED';
    }
  }
  if (probe === undefined) return 'UNKNOWN';
  // `unanswerable` FAILS CLOSED. A daemon that will not talk to us is not a daemon reporting an empty project.
  return probe(projectRoot) === 'none' ? 'UNKNOWN' : 'OCCUPIED';
}

/** The shipped probe: one `compose ps`, which resolves and lists and starts nothing. */
export function composeOccupancyProbe(runner: CommandRunner, ledger: CommandLedger): OccupancyProbe {
  return (projectRoot: string): 'containers' | 'none' | 'unanswerable' => {
    let outcome: CommandOutcome;
    try {
      outcome = runGuarded(runner, ledger, {
        program: 'docker', args: ['compose', 'ps', '-a', '--quiet'], cwd: projectRoot,
        purpose: 'ask whether this project has any containers, without starting one',
      });
    } catch {
      return 'unanswerable';
    }
    if (outcome.status !== 0) return 'unanswerable';
    return outcome.stdout.trim() === '' ? 'none' : 'containers';
  };
}

// -----------------------------------------------------------------------------------------------------------
// The plan, and the operation identity a confirmation binds
// -----------------------------------------------------------------------------------------------------------

export interface RestorePlanStep {
  readonly id: RestoreStepId;
  readonly proves: string;
  readonly destructive: boolean;
  /** The commands it issues, as values. `<staged>` stands for the run's private staging directory. */
  readonly commands: readonly MaintenanceCommand[];
  /**
   * The same commands, rendered safe to print.
   *
   * NO ABSOLUTE HOST PATH REACHES AN OUTPUT — the rule every other report in this family has always been
   * held to, and the one the first cut's `--plan` broke by printing raw argv. The project root becomes
   * `<project>` and the staging directory stays `<staged>`, so a plan is still exactly readable as a
   * sequence of operations without naming anybody's appdata layout.
   */
  readonly display: readonly string[];
}

export interface RestorePlan {
  readonly steps: readonly RestorePlanStep[];
  readonly safetySet: boolean;
  readonly acceptDataLoss: boolean;
  readonly targetState: TargetState;
  readonly custodian: CustodianTopology;
  /**
   * The digest a confirmation has to carry back — over the WHOLE operation.
   *
   * THE DEFECT THIS CLOSES. The first cut hashed the set name, the set's own digest, the topology, the
   * safety-set boolean and the step list. It did NOT hash which project, which backup destination, which
   * secrets/records/sidecar directory, what the safety set would be CALLED, or what this command believed
   * about the installation. So a digest an operator read off a plan for one project authorised a
   * same-shaped restore of the same set into a DIFFERENT project, with DIFFERENT target directories, under a
   * DIFFERENT occupancy classification — which is the whole authorisation, defeated by a paste.
   *
   * It now binds a canonical operation identity: every path, every choice, every classification, the set's
   * verified digest and the exact ordered commands. The paths go into the HASH and never into the output.
   */
  readonly digest: string;
}

export interface PlanOptions {
  readonly safetySet: boolean;
  readonly acceptDataLoss: boolean;
}

export function planCompleteRestore(resolved: ResolvedRestore, options: PlanOptions): RestorePlan {
  const cwd = resolved.projectRoot;
  const compose = (args: readonly string[], purpose: string): MaintenanceCommand =>
    ({ program: 'docker', args: ['compose', ...args], cwd, purpose });

  const ids = stepsFor({
    custodian: resolved.custodian,
    safetySet: options.safetySet,
    promotionRecords: resolved.promotionRecords !== null,
  });

  const commandsFor = (id: RestoreStepId): readonly MaintenanceCommand[] => {
    switch (id) {
      case 'stop-and-destroy':
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
          'replay the STAGED, RE-VERIFIED dump from this command\'s own descriptor')];
      case 'place-inline-keystore':
        return [
          compose(['create', '--pull', 'never', 'app'],
            'create the app container the keystore is copied into, without starting it'),
          compose(['cp', `${stagedPath(COMPONENT_ARTIFACT_NAMES.keystore)}/.`,
            `app:${INLINE_KEYSTORE_CONTAINER_PATH}`],
          'copy the STAGED, RE-VERIFIED keystore into the volume the teardown emptied'),
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
        // THE PROOF THAT ACTUALLY DECRYPTS. `ops:custody-proof` builds a real `CatalogAuthority` over this
        // installation's own custodian and decrypts active records through it. There is no way to satisfy it
        // without the key material — which is the entire point, and is what the previous `ops:collections
        // status` could not do, since it only counted rows.
        return [compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:custody-proof', '--', '--json'],
          'DECRYPT active catalog records through the shipped authority and this installation\'s custodian')];
      case 'prove-history':
        return [compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:collections', '--', 'history'],
          'read the durable, identity-minimised history')];
      default:
        return [];
    }
  };

  const steps = ids.map((id): RestorePlanStep => {
    const commands = commandsFor(id);
    return {
      id,
      proves: RESTORE_STEP_PURPOSE[id],
      destructive: DESTRUCTIVE_STEP_IDS.includes(id),
      commands,
      display: commands.map((command) => displayCommand(resolved.projectRoot, command)),
    };
  });

  return {
    steps,
    safetySet: options.safetySet,
    acceptDataLoss: options.acceptDataLoss,
    targetState: resolved.targetState,
    custodian: resolved.custodian,
    digest: operationDigest(resolved, options, steps),
  };
}

/**
 * The canonical identity of the operation a confirmation authorises.
 *
 * EVERYTHING THAT CHANGES WHAT HAPPENS IS IN HERE, and the list is deliberately exhaustive rather than
 * "the interesting parts": which project, which destination, which set, the bytes that set verified as,
 * which custody topology, every target directory, what this command concluded about the installation, what
 * the safety set would be called, whether one would be taken, whether loss was acknowledged, and the exact
 * ordered argv of every command. Paths are canonicalised to one separator so two spellings of one path
 * cannot produce two digests — and they are HASHED, never printed.
 */
export function canonicalOperation(
  resolved: ResolvedRestore,
  options: PlanOptions,
  steps: readonly RestorePlanStep[],
): string {
  const path = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
  return JSON.stringify([
    COMPLETE_RESTORE_REPORT,
    COMPLETE_RESTORE_VERSION,
    ['project', path(resolved.projectRoot)],
    ['destination', resolved.destination, path(join(resolved.projectRoot, resolved.destination))],
    ['set', resolved.setName, path(resolved.setDir), resolved.verification.setDigest,
      resolved.verification.manifestSchemaVersion],
    ['custodian', resolved.custodian],
    ['targets', ...BACKUP_COMPONENT_IDS.map((id) => {
      const target = targetForComponent(resolved, id);
      return [id, target === null ? null : target.relative, target === null ? null : path(target.dir)];
    })],
    ['present', ...[...resolved.present].sort()],
    ['targetState', resolved.targetState],
    ['safetySet', options.safetySet, resolved.safetySetName],
    ['acceptDataLoss', options.acceptDataLoss],
    ['steps', ...steps.map((step) => [step.id, ...step.commands.map((c) => [c.program, ...c.args])])],
  ]);
}

function operationDigest(
  resolved: ResolvedRestore,
  options: PlanOptions,
  steps: readonly RestorePlanStep[],
): string {
  return createHash('sha256').update(canonicalOperation(resolved, options, steps), 'utf8').digest('hex');
}

/** Which host target a component is placed at, or `null` when this run does not place it on the host. */
export function targetForComponent(resolved: ResolvedRestore, id: BackupComponentId): ResolvedTarget | null {
  switch (id) {
    case 'secrets': return resolved.secrets;
    case 'promotion-records': return resolved.promotionRecords;
    case 'keystore': return resolved.custodian === 'sidecar' ? resolved.sidecarState : null;
    case 'database': return null;
  }
}

/**
 * One command, rendered safe to print.
 *
 * The project root becomes `<project>`; anything still absolute afterwards becomes `<path>`, because an
 * argument this command did not build out of the project root is one nobody has checked the shape of.
 */
export function displayCommand(projectRoot: string, command: MaintenanceCommand): string {
  const args = command.args.map((argument) => displayArgument(projectRoot, argument));
  return `${command.program} ${args.join(' ')}`;
}

export function displayArgument(projectRoot: string, argument: string): string {
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalised = argument.replace(/\\/g, '/');
  if (normalised === root) return PROJECT_TOKEN;
  if (normalised.startsWith(`${root}/`)) return `${PROJECT_TOKEN}/${normalised.slice(root.length + 1)}`;
  return isAbsolute(argument) ? '<path>' : argument;
}

/**
 * The one statement that creates the managed runtime role.
 *
 * `pg_dump` preserves GRANT targets and does NOT dump cluster-wide roles, so the role the restored ACLs land
 * on has to exist first. It is a product constant rather than input from the dump, it is created WITHOUT a
 * login — `CREATE ROLE` defaults to NOLOGIN — and it carries no credential.
 */
export function prepareRuntimeRoleSql(): string {
  return 'DO $catalog$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '
    + `'${RUNTIME_ROLE_NAME}') THEN CREATE ROLE ${RUNTIME_ROLE_NAME}; END IF; END $catalog$;`;
}

// -----------------------------------------------------------------------------------------------------------
// The journal — a validated state machine, bound to its own paths
// -----------------------------------------------------------------------------------------------------------

/** One component this run swapped on the host, and what it moved aside to do it. */
export interface JournalSwap {
  readonly component: BackupComponentId;
  /** The target's own relative path, from the run that swapped it. NOT re-derived from a later command line. */
  readonly target: string;
  /** The leaf name, so the `.replaced-` sibling can be found without re-parsing the path. */
  readonly name: string;
  /** What the previous contents were renamed to, or `null` when the target did not exist. */
  readonly replaced: string | null;
  /** Whether `--abandon` has already put this one back. A journal is not clearable while any is `false`. */
  readonly undone: boolean;
}

export interface RestoreJournal {
  readonly journal: 'catalog-authority.restore';
  readonly version: typeof RESTORE_JOURNAL_VERSION;
  readonly planDigest: string;
  readonly setName: string;
  readonly destination: string;
  readonly custodian: CustodianTopology;
  readonly targetState: TargetState;
  readonly safetySetName: string;
  readonly suffix: string;
  readonly safetySetPlanned: boolean;
  readonly safetySetTaken: boolean;
  /**
   * The request this run was planned from, so `--resume` and `--abandon` act on the OPERATION and not on
   * whatever flags are typed next. A resume re-derives the plan from these and requires the same digest.
   */
  readonly request: {
    readonly secrets: string;
    readonly promotionRecords: string | null;
    readonly sidecarState: string | null;
  };
  /** Step ids that completed, in plan order. Validated as a prefix of the rederived plan. */
  readonly completed: readonly RestoreStepId[];
  readonly running: RestoreStepId | null;
  readonly swaps: readonly JournalSwap[];
}

export function journalPath(projectRoot: string): string {
  return join(projectRoot, RESTORE_JOURNAL_NAME);
}

/**
 * Read a journal, or answer `null` when there is none.
 *
 * -----------------------------------------------------------------------------------------------------
 * EVERY FIELD IS VALIDATED, BECAUSE EVERY FIELD IS ACTED ON.
 * -----------------------------------------------------------------------------------------------------
 *
 * This file decides which steps a resume skips, which directories an abandon renames, and what suffix goes
 * into the names it builds. The first cut checked five types and a literal. A journal is a file in a
 * directory an operator owns, and the correct posture toward it is the one this family takes toward every
 * other input: a shape it does not recognise is a REFUSAL, never an absence, and never a default.
 *
 * The structural checks are here; the checks that need the plan (is `completed` a prefix of the steps this
 * operation actually has?) are in `assertJournalAgreesWithPlan`, because they cannot be answered without one.
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
  const refuse = (why: string): never => {
    throw new MaintenanceRefused(
      `this project holds a restore journal this build will not act on: ${why}. Nothing was changed. A journal `
      + 'decides which steps are skipped and which directories are renamed, so one that is not exactly what this '
      + 'command wrote is refused rather than interpreted.');
  };
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse('it is not an object');
  const doc = parsed as Record<string, unknown>;

  if (doc.journal !== 'catalog-authority.restore') return refuse('it is not a restore journal');
  if (doc.version !== RESTORE_JOURNAL_VERSION) return refuse('its version is not one this build writes');
  if (typeof doc.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.planDigest)) {
    return refuse('its plan digest is not a sha256');
  }
  // A SUFFIX IS CONCATENATED INTO FILE NAMES. One carrying a separator or a traversal would build a sibling
  // path nobody chose, out of a file an operator can edit.
  if (typeof doc.suffix !== 'string' || !RESTORE_SUFFIX_RE.test(doc.suffix)) {
    return refuse('its suffix is not the twelve hex characters this command generates');
  }
  for (const field of ['setName', 'safetySetName'] as const) {
    const value = doc[field];
    if (typeof value !== 'string' || !MAINTENANCE_NAME_RE.test(value)) return refuse(`its ${field} is not a usable name`);
  }
  if (typeof doc.destination !== 'string' || doc.destination.trim() === '') return refuse('it has no destination');
  if (doc.custodian !== 'inline' && doc.custodian !== 'sidecar') return refuse('its custody mode is not one of two');
  if (doc.targetState !== 'OCCUPIED' && doc.targetState !== 'UNKNOWN') return refuse('its target state is not one this build classifies');
  if (typeof doc.safetySetPlanned !== 'boolean' || typeof doc.safetySetTaken !== 'boolean') {
    return refuse('its safety-set fields are not booleans');
  }
  if (doc.safetySetTaken && !doc.safetySetPlanned) return refuse('it records a safety set that was never planned');

  const request = doc.request;
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return refuse('it carries no request');
  const req = request as Record<string, unknown>;
  if (typeof req.secrets !== 'string') return refuse('it names no secrets directory');
  for (const field of ['promotionRecords', 'sidecarState'] as const) {
    if (req[field] !== null && typeof req[field] !== 'string') return refuse(`its ${field} is neither a path nor absent`);
  }
  if ((doc.custodian === 'sidecar') !== (typeof req.sidecarState === 'string')) {
    return refuse('its custody mode and its sidecar state directory disagree');
  }

  // ---- the step list --------------------------------------------------------------------------------
  if (!Array.isArray(doc.completed)) return refuse('its completed list is not a list');
  const seen = new Set<string>();
  for (const entry of doc.completed) {
    if (typeof entry !== 'string' || !(RESTORE_STEP_IDS as readonly string[]).includes(entry)) {
      return refuse('its completed list names a step this build does not have');
    }
    if (seen.has(entry)) return refuse('its completed list names one step twice');
    seen.add(entry);
  }
  if (doc.running !== null) {
    if (typeof doc.running !== 'string' || !(RESTORE_STEP_IDS as readonly string[]).includes(doc.running)) {
      return refuse('its running step is not one this build has');
    }
    if (seen.has(doc.running)) return refuse('it records a step as both running and complete');
  }

  // ---- the swaps ------------------------------------------------------------------------------------
  if (!Array.isArray(doc.swaps)) return refuse('its swap list is not a list');
  const swapped = new Set<string>();
  for (const entry of doc.swaps) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return refuse('a swap entry is not an object');
    const swap = entry as Record<string, unknown>;
    if (typeof swap.component !== 'string' || !(BACKUP_COMPONENT_IDS as readonly string[]).includes(swap.component)) {
      return refuse('a swap names a component this build does not have');
    }
    if (swapped.has(swap.component)) return refuse('a component was swapped twice');
    swapped.add(swap.component);
    if (typeof swap.target !== 'string' || swap.target.trim() === '') return refuse('a swap names no target');
    if (typeof swap.name !== 'string' || !MAINTENANCE_NAME_RE.test(swap.name)) return refuse('a swap\'s target name is not a usable name');
    if (swap.replaced !== null && (typeof swap.replaced !== 'string'
      || swap.replaced !== swapReplacedName(swap.name, doc.suffix))) {
      return refuse('a swap names a replaced directory this command would not have created');
    }
    if (typeof swap.undone !== 'boolean') return refuse('a swap does not say whether it was undone');
  }
  return doc as unknown as RestoreJournal;
}

/**
 * The checks that need the plan: does this journal describe THIS operation, and is its progress possible?
 *
 * `completed` must be a strict ORDERED PREFIX of the plan's steps. A journal that records a later step as
 * done and an earlier one as not is not a run that was interrupted — it is a run that never happened, or a
 * file somebody edited, and resuming it would perform the missing step against state that is already past it.
 */
export function assertJournalAgreesWithPlan(journal: RestoreJournal, plan: RestorePlan): void {
  if (journal.planDigest !== plan.digest) {
    throw new MaintenanceRefused(
      'the interrupted restore in this project was planned for a different operation than the one this command '
      + 'just resolved — a different project, destination, set, target directory, custody mode, safety-set name '
      + 'or occupancy. Resuming it would apply half of one restore and half of another. Nothing was changed.');
  }
  const ids = plan.steps.map((step) => step.id);
  for (const [index, id] of journal.completed.entries()) {
    if (ids[index] !== id) {
      throw new MaintenanceRefused(
        'the restore journal in this project records completed steps that are not this operation\'s steps in this '
        + 'operation\'s order. That is not an interrupted run: a run cannot finish a later step before an earlier '
        + 'one. Nothing was changed.');
    }
  }
  if (journal.running !== null) {
    const expected = ids[journal.completed.length];
    if (journal.running !== expected) {
      throw new MaintenanceRefused(
        'the restore journal records a step as running that is not the one this operation would have reached. '
        + 'Nothing was changed.');
    }
  }
  if (journal.completed.length > ids.length) {
    throw new MaintenanceRefused('the restore journal records more completed steps than this operation has');
  }
}

/**
 * Write the journal, replacing whatever it said before.
 *
 * A NEW FILE AND A RENAME, EVERY TIME. `writePrivateFile` is `O_EXCL` on purpose, so an update stages a
 * uniquely named private file beside the journal and renames it over the top — which is what makes a journal
 * read by anything else either the previous complete one or the new complete one, never a prefix of either.
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
 * Remove the journal, if it is one of ours.
 *
 * IT READS IT FIRST, AND THAT IS THE OWNERSHIP PROOF: `readRestoreJournal` refuses anything this build did
 * not write, so the `unlink` below can only ever reach a journal this product produced. This is the ONLY
 * removal of a file in this module; every other operation on operator state is a rename.
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
  readonly fileRunner: FileInputRunner;
  readonly backupFileRunner: FileOutputRunner;
  readonly ledger: CommandLedger;
  readonly suffix?: () => string;
  readonly now?: () => Date;
}

export type RestoreMode =
  | { readonly kind: 'run'; readonly confirm: string; readonly acceptDataLoss: string | null }
  | { readonly kind: 'resume'; readonly confirm: string };

export interface RestoreStepResult {
  readonly id: RestoreStepId;
  readonly proves: string;
  readonly outcome: 'held' | 'skipped' | 'failed';
  readonly detail: string | null;
}

export interface CompleteRestoreReport {
  readonly report: typeof COMPLETE_RESTORE_REPORT;
  readonly version: typeof COMPLETE_RESTORE_VERSION;
  readonly ok: boolean;
  readonly state: 'RESTORED' | 'RESTORED_BUT_UNPROVEN' | 'INCOMPLETE';
  readonly setName: string;
  readonly custodian: CustodianTopology;
  readonly targetState: TargetState;
  readonly planDigest: string;
  readonly safetySet: string | null;
  readonly safetySetVerified: boolean;
  readonly steps: readonly RestoreStepResult[];
  /**
   * Every directory whose previous contents this OPERATION kept, from the journal — not only the ones this
   * process happened to move.
   *
   * THE DEFECT THIS CLOSES. A resumed run reported an empty list, because the swaps had happened in the
   * earlier process. An operator reading the resumed run's report was told nothing had been kept, while three
   * directories of their previous secrets sat on disk unnamed.
   */
  readonly replaced: readonly string[];
  /**
   * Whether the installation DEMONSTRATED that it can decrypt its own catalog.
   *
   * Its own field, and never folded into `ok`, because a restored catalog holding no encrypted record cannot
   * prove custody and has not failed either. `ok` says the restore ran; this says whether the claim that
   * matters most was actually established.
   */
  readonly custodyProven: boolean;
  readonly schemaVersion: number;
  readonly network: 'none';
  readonly mediaAccess: 'none';
  readonly notes: readonly string[];
}

/**
 * A restore that failed after the installation was stopped.
 *
 * IT IS A STEP FAILURE, NOT A REFUSAL, and the CLI exits 1 for it. The first cut let it fall into the same
 * `catch` as a pre-destructive refusal and exited 3 — the code documented as "refused before anything was
 * destroyed" — so a scheduler watching for "nothing happened" was told nothing happened by a run that had
 * destroyed the installation's volumes.
 */
export class CompleteRestoreFailed extends MaintenanceRefused {
  readonly primary: string;
  readonly stateReached: RestoreStepId | null;
  readonly report: CompleteRestoreReport;

  constructor(primary: string, stateReached: RestoreStepId | null, report: CompleteRestoreReport) {
    super(`${primary} THE INSTALLATION IS PART WAY THROUGH A RESTORE AND IS NOT RUNNING. A journal was left in `
      + 'the project: re-run with --resume to continue from this step, or --abandon to put the host directories '
      + 'back and start again from the safety set. The report above names the safety set and every directory '
      + 'whose previous contents were kept.');
    this.name = 'CompleteRestoreFailed';
    this.primary = primary;
    this.stateReached = stateReached;
    this.report = report;
  }
}

export function runCompleteRestore(
  request: CompleteRestoreRequest,
  deps: CompleteRestoreDeps,
  mode: RestoreMode,
): CompleteRestoreReport {
  const probe = composeOccupancyProbe(deps.runner, deps.ledger);
  const existing = readRestoreJournal(resolveMaintenanceRoot(request.projectRoot, 'project root'));

  // A RESUME USES THE JOURNAL'S OWN REQUEST, NOT THE COMMAND LINE. The operation was decided when it was
  // planned; letting a later invocation re-supply the paths is how a resume swaps a directory the original
  // run never touched.
  const effective: CompleteRestoreRequest = existing === null ? request : {
    projectRoot: request.projectRoot,
    destination: existing.destination,
    setName: existing.setName,
    custodian: existing.custodian,
    secrets: existing.request.secrets,
    ...(existing.request.promotionRecords === null ? {} : { promotionRecords: existing.request.promotionRecords }),
    ...(existing.request.sidecarState === null ? {} : { sidecarState: existing.request.sidecarState }),
    safetySetName: existing.safetySetName,
  };
  const resolved = resolveCompleteRestoreRequest(effective, probe);

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

  const acceptDataLoss = mode.kind === 'run' && mode.acceptDataLoss !== null;
  const safetySet = existing !== null ? existing.safetySetPlanned : (!acceptDataLoss);
  const plan = planCompleteRestore(resolved, { safetySet, acceptDataLoss: existing?.safetySetPlanned === false || acceptDataLoss });

  // ---- authorisation -------------------------------------------------------------------------------
  if (mode.confirm !== plan.digest) {
    throw new MaintenanceRefused(
      'the confirmation does not match this plan\'s digest. Run --plan again, read what it would do, and pass the '
      + 'digest it prints. A digest is bound to the WHOLE operation — this project, this destination, this set, '
      + 'these target directories, this custody mode, this safety-set name and what this command found here — so '
      + 'one computed for any other of those is not a confirmation of this run. Nothing was changed.');
  }
  if (mode.kind === 'run') {
    if (mode.acceptDataLoss !== null && mode.acceptDataLoss !== plan.digest) {
      throw new MaintenanceRefused(
        'the acknowledgement of data loss does not carry this plan\'s digest, so it could have been pasted from '
        + 'another run, another set or another project. Nothing was changed.');
    }
    if (!safetySet && mode.acceptDataLoss === null) {
      throw new MaintenanceRefused(
        'this restore would destroy this installation\'s volumes without a safety set. Nothing was changed.');
    }
  }
  if (existing !== null) assertJournalAgreesWithPlan(existing, plan);

  const suffix = existing?.suffix ?? (deps.suffix ?? stagingSuffix)();
  if (!RESTORE_SUFFIX_RE.test(suffix)) {
    throw new MaintenanceRefused('this run produced a staging suffix that is not the shape this command creates');
  }
  const completed = new Set<RestoreStepId>(existing?.completed ?? []);
  const swaps: JournalSwap[] = existing === null ? [] : existing.swaps.map((swap) => ({ ...swap }));
  const results: RestoreStepResult[] = [];
  const notes: string[] = [];
  let safetySetTaken = existing?.safetySetTaken ?? false;
  let safetySetVerified = safetySetTaken;
  let stopped = completed.has('stop-and-destroy');
  let failedAt: RestoreStepId | null = null;
  let failure: string | null = null;
  let custodyProven = false;

  const stagingDir = join(resolved.projectRoot, stagingDirName(suffix));

  const lock = acquireMaintenanceLock(resolved.projectRoot);
  try {
    // THE DIGEST IS RE-PROVED UNDER THE LOCK, over a FRESH verification of the set.
    const reResolved = resolveCompleteRestoreRequest(effective, probe);
    const rePlan = planCompleteRestore(reResolved, { safetySet, acceptDataLoss: plan.acceptDataLoss });
    if (rePlan.digest !== plan.digest) {
      throw new MaintenanceRefused(
        'the set or the installation changed between the plan and this run, so the plan no longer describes what '
        + 'would happen. Nothing was changed. Re-plan and read it again.');
    }

    const persist = (running: RestoreStepId | null): void => {
      writeRestoreJournal(resolved.projectRoot, {
        journal: 'catalog-authority.restore',
        version: RESTORE_JOURNAL_VERSION,
        planDigest: plan.digest,
        setName: resolved.setName,
        destination: resolved.destination,
        custodian: resolved.custodian,
        targetState: resolved.targetState,
        safetySetName: resolved.safetySetName,
        suffix,
        safetySetPlanned: safetySet,
        safetySetTaken,
        request: {
          secrets: resolved.secrets.relative,
          promotionRecords: resolved.promotionRecords?.relative ?? null,
          sidecarState: resolved.sidecarState?.relative ?? null,
        },
        completed: plan.steps.map((step) => step.id).filter((id) => completed.has(id)),
        running,
        swaps: swaps.map((swap) => ({ ...swap })),
      });
    };
    persist(null);

    for (const step of plan.steps) {
      if (completed.has(step.id)) {
        results.push({ id: step.id, proves: step.proves, outcome: 'skipped', detail: 'already completed by an earlier run' });
        continue;
      }
      if (failedAt !== null && !PROOF_STEP_IDS.includes(failedAt)) break;
      persist(step.id);

      let detail: string | null;
      try {
        detail = performStep(step.id, resolved, plan, deps, stagingDir, suffix, {
          onSafetySet: (verified) => { safetySetTaken = true; safetySetVerified = verified; },
          onSwap: (swap) => { swaps.push(swap); },
          onStopped: () => { stopped = true; },
          onCustodyProven: (proven) => { custodyProven = proven; },
          onNote: (note) => { notes.push(note); },
        });
      } catch (err) {
        detail = err instanceof MaintenanceRefused
          ? err.message
          : 'this step failed for a reason this command does not have safe wording for';
      }

      if (detail !== null) {
        results.push({ id: step.id, proves: step.proves, outcome: 'failed', detail });
        if (failedAt === null) { failedAt = step.id; failure = detail; }
        if (!PROOF_STEP_IDS.includes(step.id)) break;
        continue;
      }
      completed.add(step.id);
      results.push({ id: step.id, proves: step.proves, outcome: 'held', detail: null });
      persist(null);
    }
  } finally {
    lock.release();
  }

  const everyStepHeld = failedAt === null;
  const restoredButUnproven = failedAt !== null && PROOF_STEP_IDS.includes(failedAt);

  if (everyStepHeld) {
    // THE STAGING DIRECTORY HOLDS A COPY OF EVERY SECRET IN THE INSTALLATION. It is removed on success, by
    // digest-checked ownership, so a completed restore does not leave a second copy of the keystore and the
    // secret files lying in the project.
    try {
      if (existsSync(stagingDir)) removeOwnTreeNoFollow(stagingDir, 'restore staging directory');
    } catch {
      notes.push('The private staging directory could not be removed. It holds a copy of this set\'s secrets and '
        + 'keystore: remove it yourself, the way you would remove a password.');
    }
    clearRestoreJournal(resolved.projectRoot);
    notes.push('The journal has been cleared: this restore completed and this project is not part way through one.');
  } else {
    notes.push('A restore journal was left in this project. Continue with --resume, or put the host directories '
      + 'back with --abandon. This project refuses a fresh restore until one of those has run.');
    notes.push('A private staging directory holding this set\'s verified components was left in place for the '
      + 'resume. It holds secret material.');
  }
  if (safetySetTaken) {
    notes.push('The safety set holds the installation as it was before this restore. Destroy it deliberately once '
      + 'you have confirmed this restore is the one you wanted.');
  } else {
    notes.push('NO SAFETY SET WAS TAKEN. The installation this restore replaced is not recoverable from anything '
      + 'this command produced.');
  }
  if (everyStepHeld && !custodyProven) {
    notes.push('CUSTODY WAS NOT PROVEN. The restore ran and the installation is up, but it did not demonstrate '
      + 'that it can decrypt its own catalog — see the custody proof\'s own reason. Do not treat this as a '
      + 'proven restore.');
  }

  const replaced = swaps.filter((swap) => swap.replaced !== null && !swap.undone)
    .map((swap) => swap.replaced as string);
  if (replaced.length > 0) {
    notes.push('The previous contents of the swapped directories are beside them under the names listed above. '
      + 'They hold secret material: destroy them the way you would destroy a password, once you are done.');
  }
  notes.push('Nothing was fetched and no media path was read.');

  const report: CompleteRestoreReport = {
    report: COMPLETE_RESTORE_REPORT,
    version: COMPLETE_RESTORE_VERSION,
    ok: everyStepHeld,
    state: everyStepHeld ? 'RESTORED' : restoredButUnproven ? 'RESTORED_BUT_UNPROVEN' : 'INCOMPLETE',
    setName: resolved.setName,
    custodian: resolved.custodian,
    targetState: resolved.targetState,
    planDigest: plan.digest,
    safetySet: safetySetTaken ? resolved.safetySetName : null,
    safetySetVerified,
    steps: results,
    replaced,
    custodyProven,
    schemaVersion: MIGRATION_VERSION,
    network: 'none',
    mediaAccess: 'none',
    notes,
  };

  if (failure !== null && stopped && !restoredButUnproven) {
    throw new CompleteRestoreFailed(failure, failedAt, report);
  }
  return report;
}

interface StepHooks {
  readonly onSafetySet: (verified: boolean) => void;
  readonly onSwap: (swap: JournalSwap) => void;
  readonly onStopped: () => void;
  readonly onCustodyProven: (proven: boolean) => void;
  readonly onNote: (note: string) => void;
}

function performStep(
  id: RestoreStepId,
  resolved: ResolvedRestore,
  plan: RestorePlan,
  deps: CompleteRestoreDeps,
  stagingDir: string,
  suffix: string,
  hooks: StepHooks,
): string | null {
  const step = plan.steps.find((candidate) => candidate.id === id)!;
  // `<staged>` IS SUBSTITUTED HERE AND NOWHERE ELSE, so the plan an operator confirmed and the command that
  // runs differ by exactly one thing: a directory this run created.
  const materialise = (command: MaintenanceCommand): MaintenanceCommand => ({
    ...command,
    args: command.args.map((argument) => argument.startsWith(`${STAGED_TOKEN}/`)
      ? join(stagingDir, argument.slice(STAGED_TOKEN.length + 1))
      : argument),
  });
  const runOne = (command: MaintenanceCommand): CommandOutcome =>
    runGuarded(deps.runner, deps.ledger, materialise(command));

  switch (id) {
    case 'safety-set': {
      let outcome: CompleteBackupOutcome;
      try {
        outcome = runVerifiedCompleteBackup({
          projectRoot: resolved.projectRoot,
          destination: resolved.destination,
          setName: resolved.safetySetName,
          custodian: resolved.custodian,
          secrets: resolved.secrets.relative,
          ...(resolved.sidecarState === null ? {} : { sidecarState: resolved.sidecarState.relative }),
          ...(resolved.promotionRecords === null ? {} : { promotionRecords: resolved.promotionRecords.relative }),
        }, {
          runner: deps.runner,
          fileRunner: deps.backupFileRunner,
          ledger: deps.ledger,
          holdingLock: true,
          ...(deps.now === undefined ? {} : { now: deps.now }),
        });
      } catch (err) {
        return err instanceof MaintenanceRefused
          ? `${err.message} Nothing was destroyed.`
          : 'a verified safety set could not be taken, for a reason this command does not have safe wording for. '
            + 'Nothing was destroyed.';
      }
      hooks.onSafetySet(outcome.ok);
      if (!outcome.ok) {
        return 'a verified safety set could not be taken of the installation this restore would destroy, so '
          + 'nothing was destroyed. Fix what the backup reported first.';
      }
      return null;
    }
    case 'stage-components':
      return stageComponents(resolved, stagingDir);
    case 'stop-and-destroy': {
      hooks.onStopped();
      const outcome = runOne(step.commands[0]!);
      return outcome.status === 0 ? null : 'the stack could not be stopped and its volumes destroyed';
    }
    case 'place-secrets':
      return swapComponent(resolved.secrets, stagingDir, 'secrets', suffix, 'secrets directory', hooks.onSwap);
    case 'place-promotion-records':
      return swapComponent(resolved.promotionRecords!, stagingDir, 'promotion-records', suffix,
        'promotion records directory', hooks.onSwap);
    case 'place-sidecar-keystore':
      return swapComponent(resolved.sidecarState!, stagingDir, 'keystore', suffix,
        'sidecar state directory', hooks.onSwap);
    case 'replay-database': {
      // THE STAGED, RE-VERIFIED DUMP — never the set's own file. What is replayed is what was verified.
      const dump = join(stagingDir, COMPONENT_ARTIFACT_NAMES.database);
      const outcome = runGuardedFromFile(deps.fileRunner, deps.ledger, materialise(step.commands[0]!), dump);
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
      const state = classifyDoctor(parsed);
      if (state === 'FAIL' || state === 'INVALID') return `the doctor reported ${state} on the restored installation`;
      return outcome.status === 0
        ? null
        : 'the doctor printed a healthy report and did not succeed, which do not agree';
    }
    case 'prove-decrypt': {
      // THE PROOF THAT DECRYPTS. Its BODY is what is consumed — the exit status alone would let a command
      // that failed for an unrelated reason read as "custody is fine", and a body alone would let a report
      // from a run that never finished read as a verdict. Both, and they must agree.
      const outcome = runOne(step.commands[0]!);
      const proof: CustodyProofReport | null = readCustodyProof(outcome.stdout);
      if (proof === null) {
        return 'the custody proof did not answer in the shape this build understands, so whether this '
          + 'installation can decrypt its own catalog is UNKNOWN — which is not a pass';
      }
      if (proof.verdict === 'NOT_PROVEN') {
        hooks.onCustodyProven(false);
        return `the installation could NOT decrypt ${proof.attempted - proof.outcomes.decrypted} of the `
          + `${proof.attempted} active encrypted record(s) it was asked about. That is what a keystore from a `
          + 'different moment than the database looks like, and the installation will otherwise report itself '
          + 'healthy';
      }
      if (proof.verdict === 'NO_ENCRYPTED_RECORDS') {
        // HELD, AND NOT PROVEN. The restore did not fail — there is genuinely nothing encrypted in this
        // catalog — but the claim that matters most was not established, and saying so is the whole point.
        hooks.onCustodyProven(false);
        hooks.onNote('The restored catalog holds no active encrypted record, so the custody proof had nothing to '
          + 'decrypt. This restore did NOT demonstrate that the keystore matches the database. That is a correct '
          + 'state for a set taken from an empty installation and it is not a proof of custody.');
        return null;
      }
      hooks.onCustodyProven(true);
      return outcome.status === 0
        ? null
        : 'the custody proof reported success and the command did not succeed, which do not agree';
    }
    default: {
      for (const command of step.commands) {
        const outcome = runOne(command);
        if (outcome.status !== 0) return failureSentence(id);
      }
      return null;
    }
  }
}

export function failureSentence(id: RestoreStepId): string {
  switch (id) {
    case 'database-up': return 'a fresh database did not become healthy from an image already on this host';
    case 'prepare-runtime-role': return 'the credential-free managed runtime role could not be prepared';
    case 'place-inline-keystore': return 'the set\'s keystore could not be placed in the app container\'s volume';
    case 'stack-up': return 'the restored stack did not start and become healthy';
    case 'prove-history': return 'the durable history could not be read out of the restored installation';
    default: return 'this step did not succeed';
  }
}

// -----------------------------------------------------------------------------------------------------------
// Staging: what is restored is what was verified
// -----------------------------------------------------------------------------------------------------------

/**
 * Copy every component out of the set and RE-VERIFY the copy against the manifest.
 *
 * -----------------------------------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES.
 * -----------------------------------------------------------------------------------------------------
 *
 * `verifyBackupSet` runs once, at resolution. Every placement afterwards re-opened the set BY PATH: a
 * `copyTree` walked the component directories again, and the replay bound a descriptor to the dump again.
 * Between the verification and those reads the set could change — an operator tidying up, a second process,
 * a scheduled sync, anything holding a handle on that directory — and the restore would place bytes that no
 * verification had ever approved, silently.
 *
 * So each component is staged once, through the same descriptor-safe reads every other copy in this family
 * uses, and the STAGED OBJECT is re-digested and compared to the manifest's own recorded digest, entry count
 * and byte count. A mismatch is a refusal, and it happens BEFORE the teardown, so a set that changed under
 * this command costs nothing.
 *
 * From here on, nothing reads the set again. The swaps copy from the staging directory and the replay binds
 * its descriptor to the staged dump.
 */
export function stageComponents(resolved: ResolvedRestore, stagingDir: string): string | null {
  if (existsSync(stagingDir)) {
    // A RESUME REACHES THIS ONLY IF THE STEP DID NOT COMPLETE, so a directory here is a partial stage from a
    // killed run. It is removed and rebuilt rather than trusted: a half-staged component that verified would
    // be the exact defect this step exists to prevent.
    try {
      removeOwnTreeNoFollow(stagingDir, 'restore staging directory');
    } catch {
      return 'a staging directory from an earlier attempt is here and could not be removed. Look at it before '
        + 'running again: this command will not stage into a directory it did not just create.';
    }
  }
  createPrivateDirectory(stagingDir, 'restore staging directory');

  for (const id of BACKUP_COMPONENT_IDS) {
    const declared = resolved.manifest.components.find((component) => component.id === id);
    if (declared === undefined || !declared.present) continue;
    const artifact = COMPONENT_ARTIFACT_NAMES[id];
    const source = join(resolved.setDir, artifact);
    const destination = join(stagingDir, artifact);

    if (id === 'database') {
      // STREAMED THROUGH A DESCRIPTOR, unbounded in file size and bounded in memory, and refusing to follow
      // a link at the open.
      let copied: number;
      try {
        copied = copyFileNoFollow(source, destination, `${id} component`);
      } catch (err) {
        return err instanceof MaintenanceRefused
          ? `${err.message} Nothing was destroyed.`
          : `the ${id} component could not be staged. Nothing was destroyed.`;
      }
      const staged = digestFileNoFollow(destination, `staged ${id} component`);
      if (staged.digest !== declared.digest || copied !== declared.bytes || staged.size !== declared.bytes) {
        return `the ${id} component of this set is not the one the verification approved: what was copied out `
          + 'just now does not match the digest and size the manifest recorded. The set changed after it was '
          + 'verified. Nothing was destroyed.';
      }
      continue;
    }

    try {
      copyTree(source, destination, `${id} component`);
    } catch (err) {
      return err instanceof MaintenanceRefused
        ? `${err.message} Nothing was destroyed.`
        : `the ${id} component could not be staged. Nothing was destroyed.`;
    }
    const staged = digestTreeAt(destination, `staged ${id} component`);
    if (staged.digest !== declared.digest || staged.entries !== declared.entries || staged.bytes !== declared.bytes) {
      return `the ${id} component of this set is not the one the verification approved: what was copied out just `
        + 'now does not match the digest, entry count and size the manifest recorded. The set changed after it '
        + 'was verified. Nothing was destroyed.';
    }
  }
  return null;
}

/**
 * Put one component's verified copy where the installation reads it, by RENAME.
 *
 * The source is the STAGING directory, never the set — so what lands is what was verified, and a set that
 * changes during the run cannot reach the installation.
 *
 * THE ORDER IS THE GUARANTEE, and each of the four operations is chosen for what a kill in the middle leaves:
 * a staging copy beside an untouched target; a target renamed aside under a name this command chose; the new
 * contents in place; and nothing deleted, because deleting the only copy of an operator's secrets to tidy up
 * would be the worst kind of helpfulness.
 *
 * AND IT IS IDEMPOTENT, WHICH IS WHAT MAKES `--resume` SAFE. A target already holding exactly what this set
 * would put there is recognised by digest and skipped; swapping twice would rename the RESTORED state aside
 * and record it as the previous one.
 */
function swapComponent(
  target: ResolvedTarget,
  stagingDir: string,
  id: BackupComponentId,
  suffix: string,
  what: string,
  onSwap: (swap: JournalSwap) => void,
): string | null {
  const source = join(stagingDir, COMPONENT_ARTIFACT_NAMES[id]);
  if (!existsSync(source)) {
    return `the staged ${what} is not there, so this step has nothing verified to place. Re-run the staging step.`;
  }
  const expected = digestTreeAt(source, `staged ${what}`);

  if (existsSync(target.dir)) {
    const stats = lstatSync(target.dir);
    if (stats.isSymbolicLink()) return `the ${what} is a symbolic link, which this command will not write through`;
    if (!stats.isDirectory()) return `the ${what} is not a directory`;
    if (digestTreeAt(target.dir, what).digest === expected.digest) return null;
  }

  const parent = join(target.dir, '..');
  const staging = join(parent, swapStagingName(target.name, suffix));
  const replacedName = swapReplacedName(target.name, suffix);
  const replaced = join(parent, replacedName);
  if (existsSync(staging) || existsSync(replaced)) {
    return `a previous attempt left a staging or replaced ${what} beside this one. Look at them before running `
      + 'again: this command will not write into a name it did not just create.';
  }

  copyTree(source, staging, what);
  let moved = false;
  if (existsSync(target.dir)) {
    try {
      renameSync(target.dir, replaced);
    } catch {
      return `the existing ${what} could not be moved aside, so nothing was replaced`;
    }
    moved = true;
  }
  try {
    renameSync(staging, target.dir);
  } catch {
    return `the ${what} from this set could not be moved into place. The previous one is beside it under the `
      + 'replaced name and this run stopped.';
  }
  // RECORDED AFTER BOTH RENAMES, so the journal never claims a swap that did not complete.
  onSwap({ component: id, target: target.relative, name: target.name, replaced: moved ? replacedName : null, undone: false });
  return null;
}

// -----------------------------------------------------------------------------------------------------------
// Abandoning one
// -----------------------------------------------------------------------------------------------------------

export interface AbandonReport {
  readonly report: 'phase-303-restore-abandon';
  readonly ok: boolean;
  readonly setName: string;
  readonly restored: readonly string[];
  /** Swaps this run could not put back. The journal is NOT cleared while any of these remain. */
  readonly unresolved: readonly string[];
  readonly journalCleared: boolean;
  readonly notes: readonly string[];
}

/**
 * Put the swapped host directories back, and clear the journal only if every one of them is back.
 *
 * -----------------------------------------------------------------------------------------------------
 * IT TAKES THE PROJECT ROOT AND NOTHING ELSE, AND THAT IS THE CORRECTION.
 * -----------------------------------------------------------------------------------------------------
 *
 * The first cut re-derived the targets from the CLI's `--secrets` / `--promotion-records` / `--sidecar-state`
 * flags. Those can differ from the ones the interrupted run actually swapped — by a typo, by a different
 * habit, or by a second operator — and the consequence was silent: an abandon would find no `.replaced-`
 * directory at the path it was told about, report `ok` with nothing put back, and CLEAR THE JOURNAL, leaving
 * the real swapped directories orphaned and the project accepting a fresh restore over them.
 *
 * The journal now carries the operation's own targets, and they are what this walks. It also refuses to
 * clear itself while any recorded swap is still unresolved: a partial unwind is a state that must stay
 * visible, not one that gets forgotten because the command returned.
 */
export function abandonRestore(projectRootRequested: string): AbandonReport {
  const projectRoot = resolveMaintenanceRoot(projectRootRequested, 'project root');
  const journal = readRestoreJournal(projectRoot);
  if (journal === null) {
    throw new MaintenanceRefused('there is no restore to abandon in this project: no journal is here.');
  }

  const restored: string[] = [];
  const unresolved: string[] = [];
  const notes: string[] = [];
  const swaps = journal.swaps.map((swap) => ({ ...swap }));

  for (const swap of swaps) {
    if (swap.undone) continue;
    if (swap.replaced === null) {
      // NOTHING WAS MOVED ASIDE — the target did not exist before this operation. There is nothing to put
      // back, and the restored copy is left where it is: removing it would destroy the only copy of a
      // component this command was asked to place.
      swap.undone = true;
      continue;
    }
    // THE TARGET COMES FROM THE JOURNAL, resolved against this project root and proved the same way every
    // other path is.
    let dir: string;
    try {
      dir = resolveInsideRoot(projectRoot, swap.target, `${swap.component} target`);
    } catch {
      unresolved.push(swap.replaced);
      continue;
    }
    const parent = join(dir, '..');
    const replaced = join(parent, swap.replaced);
    if (!existsSync(replaced)) { unresolved.push(swap.replaced); continue; }
    if (lstatSync(replaced).isSymbolicLink() || !statSync(replaced).isDirectory()) {
      unresolved.push(swap.replaced);
      continue;
    }
    // THE RESTORED COPY IS MOVED ASIDE, NOT DELETED. Same rule as the swap: this command does not destroy the
    // only copy of anything, and an operator who abandons and then changes their mind still holds both.
    if (existsSync(dir)) {
      const aside = join(parent, `.${swap.name}.abandoned-${journal.suffix}`);
      if (existsSync(aside)) { unresolved.push(swap.replaced); continue; }
      try { renameSync(dir, aside); } catch { unresolved.push(swap.replaced); continue; }
    }
    try { renameSync(replaced, dir); } catch { unresolved.push(swap.replaced); continue; }
    swap.undone = true;
    restored.push(swap.name);
  }

  const journalCleared = unresolved.length === 0;
  if (journalCleared) {
    clearRestoreJournal(projectRoot);
    notes.push('The journal has been cleared, so this project accepts a restore again.');
  } else {
    // THE JOURNAL STAYS, AND IT RECORDS WHAT IS STILL OUT OF PLACE. A project with an unresolved swap must
    // keep refusing a fresh restore: running one would take a "safety set" of a half-unwound installation.
    writeRestoreJournal(projectRoot, { ...journal, swaps, running: null });
    notes.push('THE JOURNAL WAS NOT CLEARED: at least one directory this restore moved aside could not be put '
      + 'back. This project keeps refusing a fresh restore until it is. Look at the names above.');
  }
  notes.push('The host directories this restore swapped are back where they were. THE DATABASE AND, IN INLINE '
    + 'CUSTODY, THE KEYSTORE WERE DESTROYED BY THE TEARDOWN AND ARE NOT COMING BACK FROM A RENAME. Restore the '
    + 'safety set to get them.');
  return {
    report: 'phase-303-restore-abandon',
    ok: journalCleared,
    setName: journal.setName,
    restored,
    unresolved,
    journalCleared,
    notes,
  };
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
  lines.push(`  custody proven     ${report.custodyProven ? 'YES — it decrypted its own catalog' : 'NO'}`);
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
  lines.push(`  RESULT: ${report.ok && report.custodyProven ? 'RESTORED AND PROVED' : report.state}`);
  return lines.join('\n');
}

/** `--plan`'s rendering: the ordered steps and the digest a confirmation has to carry back. */
export function renderRestorePlan(resolved: ResolvedRestore, plan: RestorePlan): string {
  const lines: string[] = [];
  lines.push(`This restore would put set "${resolved.setName}" back, with no shell involved:`);
  lines.push(`  the installation it would restore into is ${plan.targetState}`);
  if (plan.targetState === 'UNKNOWN') {
    lines.push('    — its host directories are empty, and this command CANNOT prove its Docker volumes are.');
    lines.push('      Reading a volume means starting something, and starting something is a change.');
  }
  lines.push(`  custody is ${plan.custodian}, which the set's own manifest agrees with`);
  lines.push(plan.safetySet
    ? `  a verified safety set would be taken first, named "${resolved.safetySetName}"`
    : '  NO SAFETY SET WOULD BE TAKEN, and destroying this installation\'s volumes was acknowledged');
  lines.push('');
  for (const step of plan.steps) {
    lines.push(`  ${step.destructive ? '!' : ' '} ${step.id}`);
    lines.push(`      ${step.proves}`);
    // THE SAFE RENDERING. `<project>` stands for the project root and `<staged>` for this run's private
    // staging directory: a plan is exactly readable without naming anybody's appdata layout.
    for (const command of step.display) lines.push(`      ${command}`);
  }
  lines.push('');
  lines.push('  ! marks a step after which this installation is not where it was.');
  lines.push('  <project> is the project directory you named; <staged> is a private directory this run creates.');
  lines.push('  Components are placed by RENAME: the previous directory is kept beside the new one.');
  lines.push('  Nothing would be fetched and no media path would be read.');
  lines.push('');
  lines.push(`  plan digest: ${plan.digest}`);
  lines.push('  It binds this project, this destination, this set and its verified bytes, these target');
  lines.push('  directories, this custody mode, this safety-set name and what was found here. A digest from');
  lines.push('  any other operation will not confirm this one. Nothing has been changed.');
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

/** Exported so a suite can assert that no rendered surface carries a path outside the project. */
export function projectRelative(projectRoot: string, path: string): string {
  const inside = relativePath(projectRoot, path);
  return inside === '' ? PROJECT_TOKEN : `${PROJECT_TOKEN}/${inside.replace(/\\/g, '/')}`;
}
