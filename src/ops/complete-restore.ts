import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join, relative as relativePath } from 'node:path';
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
  STEP_RECOVERY,
  STEP_REWIND_TO,
  stepsFor,
  swapReplacedName,
  swapStagingName,
  type CustodianTopology,
  type RestoreStepId,
} from './restore-model.js';
import {
  MAINTENANCE_LOCK_DIRNAME,
  MAINTENANCE_NAME_RE,
  MaintenanceRefused,
  acquireMaintenanceLock,
  assertPlainTree,
  assertUsableName,
  copyFileNoFollow,
  createPrivateDirectory,
  digestFileNoFollow,
  readFileNoFollow,
  removeOwnFileNoFollow,
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
export const RESTORE_JOURNAL_VERSION = 4;
/** A journal is small by construction. A file at that name larger than this is not one of ours. */
export const MAX_JOURNAL_BYTES = 64 * 1024;

/** Where the keystore lands inside the app container, in inline custody. Fixed by this project's images. */
export const INLINE_KEYSTORE_CONTAINER_PATH = '/var/lib/catalog/keystore';

/** How long the two `up` steps wait for their declared healthchecks, in seconds. */
export const DATABASE_WAIT_SECONDS = 60;
export const STACK_WAIT_SECONDS = 120;

/** What a rendered command shows where the project root is. No absolute host path reaches an output. */
export const PROJECT_TOKEN = '<project>';

/**
 * The suffix every name this operation creates is built from.
 *
 * Twelve hex characters of the plan digest. Deterministic on purpose: a resume rebuilds the staging and swap
 * names without trusting a number in a file, and those names are protected by an ownership MARKER rather
 * than by being hard to guess.
 *
 * IT IS DELIBERATELY NOT WHAT PROVES THE SAFETY SET IS OURS. See `SafetySetClaim`: a deterministic name is a
 * PREDICTABLE one, and predictable is exactly what a provenance check must not rest on.
 */
export function operationSuffix(planDigest: string): string {
  return planDigest.slice(0, 12);
}

/**
 * The directory THIS RUN claims, exclusively, to publish its safety set into.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHY A NAME — ANY NAME — IS NOT PROVENANCE.
 * -----------------------------------------------------------------------------------------------------
 *
 * The first attempt at this bound the safety set to a name derived from the plan digest, on the reasoning
 * that no other operation could produce it. That reasoning was wrong in the way that matters: the plan
 * digest is DETERMINISTIC, so the derived name is PREDICTABLE — and a perfectly ordinary sequence produces a
 * valid, unrelated set sitting at it. Run the same restore, abandon it, leave its safety set on disk; run it
 * again, die inside the safety-set step before `ops:complete-backup` refuses the existing name. The set now
 * at that name is a backup of the installation as it was before the FIRST run, not the second — a different
 * moment — and a recovery that adopts it hands the operator a safety set that does not describe what is
 * about to be destroyed.
 *
 * "The name matches" can never distinguish "we published it" from "it was already there and blocked us",
 * because those two states are identical on disk. So the claim is made out of something that is not a name:
 *
 *   1. A NONCE that is drawn from the system CSPRNG, per run — not derived from anything, and so not
 *      predictable by anybody who has not read this run's journal.
 *   2. A DIRECTORY created with `mkdir`, which is the one filesystem operation that both creates and refuses
 *      atomically. Creating it IS the claim: it succeeds for exactly one party.
 *   3. Recorded in the journal only AFTER that `mkdir` returned, so `created: true` means this run really
 *      did create that directory rather than find it.
 *
 * The safety set is then published INSIDE the claimed directory. "It is in a directory this run created,
 * under a name nobody could guess" is provenance a pre-existing set cannot have, however it is named. A
 * claim that was never created, or a directory that turns out to belong to somebody else, sends the run to a
 * fresh nonce rather than to an adoption.
 */
export interface SafetySetClaim {
  /** 24 hex characters from the system CSPRNG. Not derived from anything. */
  readonly nonce: string;
  /** True only once `mkdir` on the claim directory returned successfully to THIS run. */
  readonly created: boolean;
}

/** The shape a claim nonce must have. Validated wherever it is concatenated into a path. */
export const SAFETY_CLAIM_NONCE_RE = /^[0-9a-f]{24}$/;

/** Where a claim's directory sits, relative to the backup destination. */
export function safetySetClaimDirName(nonce: string): string {
  return `.pre-restore-claim-${nonce}`;
}

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

  // ---- 4. NO DESTRUCTIVE PATH MAY OVERLAP ANOTHER ---------------------------------------------------
  //
  // -----------------------------------------------------------------------------------------------------
  // EQUALITY WAS NOT THE PROPERTY. CONTAINMENT IS.
  // -----------------------------------------------------------------------------------------------------
  //
  // The first version compared the three target directories for EQUALITY, which catches
  // `--secrets x --sidecar-state x` and nothing else. Every one of these is destructive and none of them is
  // equality:
  //
  //   * NESTING. `--secrets a --promotion-records a/b`. The secrets swap renames `a` aside WHOLE, taking
  //     `a/b` with it; the records swap then creates `a/b` fresh under a directory that no longer holds
  //     what either component was restored from. One `.replaced-` name now covers two components, and
  //     `--abandon` puts back a tree containing the wrong one.
  //   * THE BACKUP DESTINATION. `--secrets backups`. The swap renames the destination aside — including
  //     THE SET BEING RESTORED and the safety set taken minutes earlier — and the very next step reads from
  //     a path that has just moved. The one directory this command must never touch is the one holding the
  //     only copies of everything.
  //   * THIS COMMAND'S OWN NAMESPACES. A target whose leaf collides with the journal, the lock, the staging
  //     directory or a `.replaced-`/`.restoring-`/`.abandoned-` sibling would have this command's own
  //     bookkeeping renamed by its own placement.
  //
  // ALL OF IT IS REFUSED HERE, before a command is built, before the lock is taken and before a journal
  // exists — so a project pointed at itself costs nothing.
  const claims: { readonly what: string; readonly path: string }[] = [
    ...[secrets, promotionRecords, sidecarState]
      .filter((target): target is ResolvedTarget => target !== null)
      .map((target) => ({ what: `the ${target.relative} target`, path: target.dir })),
  ];
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      if (pathsOverlap(claims[i]!.path, claims[j]!.path)) {
        throw new MaintenanceRefused(
          'two components were pointed at the same directory, or at one inside the other. Restoring both would '
          + 'rename one component\'s directory aside with the other still inside it, and leave a single kept '
          + 'copy that an abandon would put back over the wrong one. Nothing was changed.');
      }
    }
  }
  // THE PLACES THIS COMMAND READS FROM AND WRITES ITS OWN STATE INTO. A target may be none of them, and may
  // neither contain nor sit inside any of them.
  const reserved: readonly { readonly what: string; readonly path: string }[] = [
    { what: 'the backup destination', path: destinationDir },
    { what: 'the backup set being restored', path: setDir },
    { what: 'this command\'s restore journal', path: journalPath(projectRoot) },
    { what: 'this project\'s maintenance lock', path: join(projectRoot, MAINTENANCE_LOCK_DIRNAME) },
  ];
  for (const claim of claims) {
    for (const guarded of reserved) {
      if (pathsOverlap(claim.path, guarded.path)) {
        throw new MaintenanceRefused(
          `a component was pointed at ${guarded.what}, or at a directory containing it or inside it. This `
          + 'command would then rename, replace or destroy the very thing it is reading from or recording '
          + 'its own progress in. Nothing was changed.');
      }
    }
    // THE NAMESPACES THIS COMMAND CREATES BESIDE A TARGET. A leaf that is one of them would have this
    // command's own bookkeeping swapped by its own placement.
    if (RESERVED_LEAF_RE.test(basename(claim.path))) {
      throw new MaintenanceRefused(
        'a component was pointed at a directory whose name is one this command creates for its own '
        + 'bookkeeping — a staging, replaced, restoring or abandoned copy. Nothing was changed.');
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
    targetState: classifyTarget(projectRoot,
      [secrets, promotionRecords, sidecarState].filter((t): t is ResolvedTarget => t !== null), probe),
    verification,
    manifest,
  };
}

/**
 * Do these two paths name the same place, or does either contain the other?
 *
 * Separators are normalised and a trailing one dropped, so two spellings of one path answer the same; the
 * containment test then compares whole SEGMENTS, because `a/bc` is not inside `a/b` however the strings
 * begin. Both paths have already been resolved, so no `..` survives to be reasoned about here.
 */
export function pathsOverlap(a: string, b: string, caseInsensitive = HOST_PATHS_ARE_CASE_INSENSITIVE): boolean {
  // -----------------------------------------------------------------------------------------------------
  // THE COMPARISON MUST MATCH THE FILESYSTEM, NOT THE STRING.
  // -----------------------------------------------------------------------------------------------------
  //
  // THE DEFECT THIS CLOSES. The comparison was case-SENSITIVE, and this product ships on Windows, where
  // `SECRETS` and `secrets` are one directory. `--secrets secrets --promotion-records SECRETS` therefore
  // passed the overlap guard while naming ONE directory twice: the second placement renames the first
  // component's freshly restored directory aside and records it as "the previous contents". `--secrets
  // BACKUPS` renames the backup destination aside — with the set being restored inside it — while the guard
  // that exists to prevent exactly that compares two strings that differ.
  //
  // Containment is still whole-SEGMENT: `a/bc` is not inside `a/b` however the strings begin, and folding
  // case does not change that.
  const norm = (value: string): string => {
    const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? slashed.toLowerCase() : slashed;
  };
  const left = norm(a);
  const right = norm(b);
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Whether this host's filesystem identifies paths without regard to case.
 *
 * Windows and macOS default to case-insensitive; Linux does not. A constant rather than a probe, because
 * probing means creating a file to find out — and the question this product needs answered is "could two
 * spellings name one directory here", for which the platform default is the safe reading. On a
 * case-sensitive volume mounted under Windows the only cost is refusing two targets that could have coexisted.
 */
export const HOST_PATHS_ARE_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Leaf names this command creates beside a target for its own bookkeeping.
 *
 * A target with one of these names would have the command's own staging, kept or in-flight copy renamed by
 * its own placement. `assertUsableName` already refuses a leading dot, so this is belt and braces for the
 * one case where it would matter most — and it is checked rather than assumed.
 */
export const RESERVED_LEAF_RE = /^\.(catalog-restore|.*\.(replaced|restoring|abandoned)-)/;

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
  /**
   * The name this operation's safety set is published under — derived from the operation, not chosen.
   *
   * THE DEFECT THIS CLOSES. Recovery treated ANY verifying set at the operator's chosen safety-set name as
   * belonging to this interrupted restore. It need not: `ops:complete-backup` REFUSES an existing set name,
   * so the very state that makes recovery necessary — a process that died inside the safety-set step — is
   * also the state a set that ALREADY EXISTED under that name produces, by making this run's backup fail. A
   * resume then adopted a stranger's backup as the only thing standing between this installation and
   * unrecoverable loss, and reported it as verified.
   *
   * The published name carries twelve hex characters of this operation's plan digest, so recovery asks
   * about THAT name and no other. A set at the base name is somebody else's: not adopted, not replaced, not
   * touched.
   */
  /**
   * This run's exclusive claim on somewhere to publish its safety set, or `null` before one is made.
   *
   * Written BEFORE the backup runs — the correct side of the absence/publication boundary — so that
   * "the set is inside a directory we created" is a fact a recovery can rely on rather than infer.
   */
  readonly safetySetClaim: SafetySetClaim | null;
  /**
   * WHICH DIRECTION THIS OPERATION IS GOING, and it is exclusive.
   *
   * THE DEFECT THIS CLOSES. `--abandon` could partially unwind targets, remove the staging tree and write
   * ordinary restore step states — and a `--resume` arriving afterwards read those step states and
   * RECONSTRUCTED THE RESTORE ON TOP OF THE UNWIND, placing components back over directories an operator had
   * just asked to have put back. Nothing anywhere recorded that a decision to abandon had been made.
   *
   * It is written BEFORE the first rename an abandon performs. Once it says `abandoning`, a run and a resume
   * refuse with ZERO effects and only another abandon may continue.
   */
  readonly phase: RestorePhase;
  readonly safetySetPlanned: boolean;
  readonly safetySetTaken: boolean;
  /**
   * EXACTLY WHAT THIS OPERATION STAGED, recorded before anything was destroyed.
   *
   * THE DEFECT THIS CLOSES. An abandon removes the staging tree — a recursive deletion of a directory
   * holding a copy of every secret in the installation — and it runs from the journal alone, long after the
   * set it came from may have been moved, renamed or archived. It therefore had NO manifest to compare the
   * ownership marker against, and settled for "the marker names this plan and this suffix", which a marker
   * describing entirely different components satisfies.
   *
   * The commitment is written with the first journal of the operation, before the safety set, the teardown
   * or a single copy — so it exists on the safe side of every destructive act — and it is validated
   * canonically on every read, exactly as the marker is. An abandon compares the marker against THIS, and
   * a run compares the two against each other: they cannot disagree without the journal having been edited.
   */
  readonly stagingCommitment: StagingMarker['components'];
  /**
   * The request this run was planned from, so `--resume` and `--abandon` act on the OPERATION and not on
   * whatever flags are typed next. A resume re-derives the plan from these and requires the same digest.
   */
  readonly request: {
    readonly secrets: string;
    readonly promotionRecords: string | null;
    readonly sidecarState: string | null;
  };
  /**
   * Every step of this operation, with the state it is actually in.
   *
   * -----------------------------------------------------------------------------------------------------
   * WHY THIS IS NOT A LIST OF COMPLETED STEPS ANY MORE.
   * -----------------------------------------------------------------------------------------------------
   *
   * THE DEFECT THIS CLOSES, AND THE RUN THAT PRODUCED IT COULD NOT BE RESUMED AT ALL. The proofs are
   * independent diagnoses and every one of them runs even after an earlier one fails — that was itself a
   * correction, and it is right. But the journal recorded progress as an ORDERED LIST OF COMPLETED STEPS
   * validated as a PREFIX of the plan, and those two facts cannot both hold: a run whose `prove-version`
   * failed and whose `prove-doctor` succeeded wrote `[…, prove-doctor, prove-decrypt, prove-history]` with
   * `prove-version` missing from the middle, which its own reader then refused as "not this operation's
   * steps in this operation's order". The installation was left part way through a restore, refusing a
   * fresh run because a journal was present and refusing a resume because the journal it had just written
   * was illegal. That is not a diagnosis, it is a dead end.
   *
   * A LIST OF COMPLETED THINGS CANNOT EXPRESS A FAILURE THAT IS NOT FATAL. So progress is per step, each
   * one carrying the state it is in and the closed sentence for why, and the legality rules say what
   * combinations a real run can produce. Nothing has to be inferred from an absence.
   */
  readonly steps: readonly JournalStep[];
  readonly swaps: readonly JournalSwap[];
  /**
   * What this operation has ESTABLISHED so far, as opposed to what it has done.
   *
   * THE DEFECT THIS CLOSES. `custodyProven` lived only in the running process. A run that proved custody and
   * then failed `prove-history` left a journal with `prove-decrypt` complete; the resume skipped that step,
   * because it was complete, and therefore never set the flag — and reported a fully successful restore as
   * `custody proven: NO`. The most important claim this command makes was being destroyed by the recovery
   * path for an unrelated failure.
   *
   * Evidence that decides the final report is now persisted with the step that produced it, and restored
   * with it. A resume answers what the OPERATION established, not what its last process happened to see.
   */
  readonly evidence: RestoreEvidence;
}

/** The state one step of an operation is in. `running` is the only state a crash can leave. */
export type JournalStepState = 'pending' | 'running' | 'complete' | 'failed';

export interface JournalStep {
  readonly id: RestoreStepId;
  readonly state: JournalStepState;
  /** The closed sentence for a failure. Never interpolated with anything read at runtime. */
  readonly detail: string | null;
}

/**
 * What the operation has established, carried across processes.
 *
 * Each field is a fact a LATER report depends on and an EARLIER step produced, which is exactly the set of
 * things a resume cannot recompute — the step that produced them is complete and will not run again.
 */
/** Which direction an operation is going. Recorded before the first effect of that direction. */
export type RestorePhase = 'restoring' | 'abandoning';

export interface RestoreEvidence {
  /** Whether the installation DEMONSTRATED that it can decrypt its own catalog. */
  readonly custodyProven: boolean;
  readonly safetySetTaken: boolean;
  readonly safetySetVerified: boolean;
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
  if (doc.phase !== 'restoring' && doc.phase !== 'abandoning') return refuse('its phase is not one this build has');
  if (doc.safetySetClaim !== null) {
    // THE NONCE IS CONCATENATED INTO A DIRECTORY NAME, so it is held to a shape the way every other value
    // this command builds a path out of is.
    const claim = doc.safetySetClaim;
    if (claim === undefined || typeof claim !== 'object' || Array.isArray(claim)) {
      return refuse('its safety-set claim is not a claim');
    }
    const record = claim as Record<string, unknown>;
    if (typeof record.nonce !== 'string' || !SAFETY_CLAIM_NONCE_RE.test(record.nonce)) {
      return refuse('its safety-set claim nonce is not the twenty-four hex characters this command draws');
    }
    if (typeof record.created !== 'boolean') return refuse('its safety-set claim does not say whether it was created');
    if (doc.safetySetPlanned !== true && record.created === true) {
      return refuse('it records a claim created for a safety set this operation never planned');
    }
  }
  if (typeof doc.safetySetPlanned !== 'boolean' || typeof doc.safetySetTaken !== 'boolean') {
    return refuse('its safety-set fields are not booleans');
  }
  if (doc.safetySetTaken && !doc.safetySetPlanned) return refuse('it records a safety set that was never planned');

  // ---- the staging commitment, which authorises a recursive deletion of secrets ---------------------
  if (!Array.isArray(doc.stagingCommitment)) return refuse('it carries no staged-component commitment');
  const committed = new Set<string>();
  let previous = -1;
  for (const entry of doc.stagingCommitment) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return refuse('its staged-component commitment holds something that is not a component');
    }
    const component = entry as Record<string, unknown>;
    const index = typeof component.id === 'string'
      ? (BACKUP_COMPONENT_IDS as readonly string[]).indexOf(component.id) : -1;
    if (index < 0) return refuse('its staged-component commitment names a component this build does not have');
    if (committed.has(component.id as string)) return refuse('its staged-component commitment names one component twice');
    committed.add(component.id as string);
    // IN THE MODEL'S OWN ORDER, because the marker comparison is positional and a reordered commitment
    // would silently compare the wrong pairs.
    if (index <= previous) return refuse('its staged-component commitment is out of this build\'s component order');
    previous = index;
    if (component.artifact !== COMPONENT_ARTIFACT_NAMES[component.id as BackupComponentId]) {
      return refuse('its staged-component commitment names an artifact that is not the one for that component');
    }
    if (typeof component.digest !== 'string' || !/^[0-9a-f]{64}$/.test(component.digest)) {
      return refuse('its staged-component commitment carries a digest that is not one');
    }
    for (const count of [component.entries, component.bytes]) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        return refuse('its staged-component commitment carries a count that is not one');
      }
    }
  }

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

  // ---- the steps ------------------------------------------------------------------------------------
  if (!Array.isArray(doc.steps)) return refuse('its step list is not a list');
  if (doc.steps.length === 0) return refuse('it records no steps at all');
  const seen = new Set<string>();
  let running = 0;
  for (const entry of doc.steps) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return refuse('a step entry is not an object');
    const step = entry as Record<string, unknown>;
    if (typeof step.id !== 'string' || !(RESTORE_STEP_IDS as readonly string[]).includes(step.id)) {
      return refuse('it names a step this build does not have');
    }
    if (seen.has(step.id)) return refuse('it names one step twice');
    seen.add(step.id);
    if (step.state !== 'pending' && step.state !== 'running' && step.state !== 'complete' && step.state !== 'failed') {
      return refuse('a step is in a state this build does not have');
    }
    if (step.state === 'running') running += 1;
    if (step.detail !== null && typeof step.detail !== 'string') return refuse('a step detail is neither absent nor a sentence');
    // ONLY A FAILURE CARRIES A REASON. A `complete` step with a detail is a record of two different things,
    // and a `failed` step without one is a failure nobody can act on.
    if (step.state === 'failed' && typeof step.detail !== 'string') return refuse('a failed step records no reason');
    if (step.state !== 'failed' && step.detail !== null) return refuse('a step that did not fail carries a reason');
  }
  // ONE PROCESS, ONE STEP. A journal recording two steps as running is not a crash — a crash leaves exactly
  // the one the process was inside — so it is a file somebody edited or two runs that raced the lock.
  if (running > 1) return refuse('it records more than one step as running, which one process cannot produce');

  // ---- the evidence ---------------------------------------------------------------------------------
  const evidence = doc.evidence;
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return refuse('it carries no evidence');
  const ev = evidence as Record<string, unknown>;
  for (const field of ['custodyProven', 'safetySetTaken', 'safetySetVerified'] as const) {
    if (typeof ev[field] !== 'boolean') return refuse(`its ${field} evidence is not a boolean`);
  }
  if (ev.safetySetVerified === true && ev.safetySetTaken !== true) {
    return refuse('it records a safety set as verified that was never taken');
  }
  if (ev.safetySetTaken === true && doc.safetySetPlanned !== true) {
    return refuse('its evidence records a safety set that this operation never planned');
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
  // ---- 1. THE SAME STEPS, IN THE SAME ORDER ---------------------------------------------------------
  const ids = plan.steps.map((step) => step.id);
  if (journal.steps.length !== ids.length || journal.steps.some((step, index) => step.id !== ids[index])) {
    throw new MaintenanceRefused(
      'the restore journal in this project does not describe this operation\'s steps, in this operation\'s '
      + 'order. Resuming it would apply half of one restore and half of another. Nothing was changed.');
  }

  // ---- 2. A STATE A REAL RUN COULD HAVE PRODUCED -----------------------------------------------------
  //
  // The rules are the shape of the executor, written down. It runs the steps in order; a NON-PROOF failure
  // stops it; a PROOF failure does not, because the proofs are independent diagnoses. So:
  //
  //   * the non-proof steps are `complete`* then at most one `running`/`failed`, then `pending`*;
  //   * the proofs are all `pending` until every non-proof step is complete;
  //   * and once the proofs are reachable they are (`complete`|`failed`)* then at most one `running`, then
  //     `pending`*, because they too are attempted in order.
  //
  // A journal outside those shapes was not written by a run of this program.
  const refuse = (why: string): never => {
    throw new MaintenanceRefused(
      `the restore journal in this project records a state no run of this operation could have produced: ${why}. `
      + 'Nothing was changed. Look at it before running anything.');
  };
  const proofs = journal.steps.filter((step) => PROOF_STEP_IDS.includes(step.id));
  const others = journal.steps.filter((step) => !PROOF_STEP_IDS.includes(step.id));

  const walk = (steps: readonly JournalStep[], settled: readonly JournalStepState[], what: string): void => {
    let stopped = false;
    for (const step of steps) {
      if (stopped) {
        if (step.state !== 'pending') refuse(`${what} record ${step.id} as ${step.state} after an earlier step stopped`);
        continue;
      }
      if (settled.includes(step.state)) continue;
      // `running` or `failed` (or `pending`) — whatever it is, nothing after it may have started.
      stopped = true;
    }
  };
  // A non-proof step is settled only by completing: a failure there stops the run.
  walk(others, ['complete'], 'the steps before the proofs');
  // A proof is settled either way: a failed proof does not stop the ones after it.
  walk(proofs, ['complete', 'failed'], 'the proofs');

  if (others.some((step) => step.state !== 'complete') && proofs.some((step) => step.state !== 'pending')) {
    refuse('a proof was reached before every step before it had completed');
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
  /**
   * The rename this command performs, injected. Phase 303 (second correction).
   *
   * SAME IDIOM AS `CommandRunner`, AND FOR THE SAME REASON. A swap is two renames, and the states a crash
   * can leave BETWEEN them are exactly the states the recovery exists for. Without a seam at the effect
   * itself, "the process died after the first rename and before the second" is not something a suite can
   * produce deterministically — and an untestable recovery path is one nobody can claim works. Production
   * passes `renameSync`.
   */
  readonly rename?: Renamer;
  /**
   * The journal write itself, injected. Phase 303 (second correction).
   *
   * THE JOURNAL IS AN EFFECT THIS COMMAND PERFORMS, and it is the one whose ORDER relative to every other
   * effect is the whole crash-consistency argument: intent before the effect, result after it. A seam here
   * is what lets a suite stop the process at the exact instant an effect has landed and its record has not
   * — which is the state, and the only state, the recovery exists for. Production passes
   * `writeRestoreJournal`.
   */
  readonly journalWriter?: JournalWriter;
  /**
   * How one component is copied into staging, injected. Phase 303 (correction 3b).
   *
   * SAME IDIOM AS `Renamer` AND `JournalWriter`, AND THE SAME REASON: a copy is synchronous, so "the
   * process died in the middle of copying the keystore" is a state no timer, signal or exception can produce
   * from outside it. Without a seam at the effect, the claim/seal protocol that exists precisely for that
   * window would be untestable — and an untestable recovery is one nobody can claim works. Production passes
   * `realStagingCopier`.
   */
  readonly copier?: StagingCopier;
}

/** Copy one component of a backup set into the staging directory. */
export type StagingCopier = (source: string, destination: string, id: BackupComponentId) => void;

/** The shipped copier: a descriptor-streamed file for the dump, a no-follow tree walk for everything else. */
export const realStagingCopier: StagingCopier = (source, destination, id) => {
  if (id === 'database') copyFileNoFollow(source, destination, `${id} component`);
  else copyTree(source, destination, `${id} component`);
};

/** One rename. Injected so a suite can stop a run between the two halves of a swap. */
export type Renamer = (from: string, to: string) => void;

/** How a journal reaches the disk. Injected for the same reason every other effect here is. */
export type JournalWriter = (projectRoot: string, journal: RestoreJournal) => void;

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
  /**
   * The private staging tree, when a completed restore could not prove ownership of it and remove it.
   *
   * It holds a copy of every secret in the installation. A run that leaves one keeps its journal, so the
   * project keeps refusing a fresh restore rather than forgetting a second copy of everything exists.
   */
  readonly stagingUnresolved: string | null;
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

  // ---- THE DIRECTION IS CHECKED BEFORE ANYTHING IS TOUCHED -----------------------------------------
  //
  // THE DEFECT THIS CLOSES. This check used to sit AFTER the request was resolved — which verifies the backup
  // set, opens its manifest and runs the occupancy probe against Docker. "A run and a resume refuse with zero
  // effects" was therefore not true: they read the set, started a probe, and could fail on a MOVED OR MISSING
  // SET or an unreachable daemon instead of telling the operator the one thing that matters, which is that
  // somebody asked for this restore to be put back and only `--abandon` may continue it.
  //
  // It is now the first thing that happens after the journal has been read and validated: before the request
  // is resolved, before the set is opened, before Docker is asked anything, before a plan exists and before a
  // confirmation is compared.
  if (existing !== null && existing.phase === 'abandoning') {
    throw new MaintenanceRefused(
      'this project is being ABANDONED, not restored: an operator asked for the interrupted restore to be put '
      + 'back, and that unwind is not finished. Continuing the restore now would place components back over '
      + 'directories somebody has just asked to have returned to what they were. THE ONLY COMMAND THAT MAY '
      + 'CONTINUE HERE IS --abandon. Nothing was read, nothing was probed and nothing was changed.');
  }

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
  // ---- THE CLASSIFICATION IS THE OPERATION'S, NOT THIS PROCESS'S -----------------------------------
  //
  // THE DEFECT THIS CLOSES. `targetState` is bound into the plan digest, and a resume re-derived it from the
  // installation AS IT IS NOW — after this very operation has placed components into it. A restore into a
  // target this command could not prove empty is classified UNKNOWN; the moment it places the records
  // directory, the same installation classifies OCCUPIED, the rederived plan digest changes, and EVERY
  // resume of that operation is refused for "not describing this operation". The classification is a
  // pre-flight fact about the installation BEFORE the operation ran, so it is taken from the journal, which
  // is where that fact was recorded.
  const resolved = existing === null
    ? resolveCompleteRestoreRequest(effective, probe)
    : { ...resolveCompleteRestoreRequest(effective, probe), targetState: existing.targetState };

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

  const suffix = existing?.suffix ?? (deps.suffix ?? (() => operationSuffix(plan.digest)))();
  let safetySetClaim: SafetySetClaim | null = existing?.safetySetClaim ?? null;
  if (!RESTORE_SUFFIX_RE.test(suffix)) {
    throw new MaintenanceRefused('this run produced a staging suffix that is not the shape this command creates');
  }
  // ---- the operation's state, restored from the journal or started fresh ----------------------------
  //
  // EVIDENCE COMES BACK WITH IT. A resume answers what the OPERATION established, not what this process saw.
  const state = new Map<RestoreStepId, JournalStep>(
    plan.steps.map((step) => [step.id, { id: step.id, state: 'pending' as JournalStepState, detail: null }]));
  for (const recorded of existing?.steps ?? []) state.set(recorded.id, { ...recorded });
  const swaps: JournalSwap[] = existing === null ? [] : existing.swaps.map((swap) => ({ ...swap }));
  const evidence: RestoreEvidence = existing?.evidence ?? {
    custodyProven: false, safetySetTaken: false, safetySetVerified: false,
  };
  let custodyProven = evidence.custodyProven;
  let safetySetTaken = evidence.safetySetTaken;
  let safetySetVerified = evidence.safetySetVerified;

  const results: RestoreStepResult[] = [];
  const notes: string[] = [];
  let stopped = state.get('stop-and-destroy')?.state === 'complete';
  let failedAt: RestoreStepId | null = null;
  let failure: string | null = null;
  // BUILT INSIDE THE LOCK, read outside it. The throw below is the only thing that happens after the lock,
  // and it performs no effect — it reports one.
  let report: CompleteRestoreReport | null = null;
  let restoredButUnproven = false;
  /** The staging tree, when a completed restore could not prove it was ours and remove it. */
  let stagingUnresolved: string | null = null;

  const stagingDir = join(resolved.projectRoot, stagingDirName(suffix));

  // ---- THE LOCK A CRASHED RUN LEFT BEHIND -----------------------------------------------------------
  //
  // A process that stops existing never reaches its `finally`, so it leaves this project's maintenance lock
  // directory on disk. The next resume then hits "another maintenance command is already running" — which is
  // true-sounding, unhelpful, and names neither the journal beside it nor what to do.
  //
  // THE LOCK IS STILL NOT BROKEN AUTOMATICALLY. This family's rule is that a stale lock is reported and never
  // removed by a program, because removing it means guessing whether another process is alive — and a restore
  // is the worst possible command to be wrong about that in. What changes is that the two facts are reported
  // TOGETHER, so an operator is told the specific thing that happened rather than a generic contention
  // message that does not mention the interrupted restore sitting next to it.
  let lock;
  try {
    lock = acquireMaintenanceLock(resolved.projectRoot);
  } catch (err) {
    if (existing !== null) {
      throw new MaintenanceRefused(
        'this project holds BOTH an interrupted restore journal and a maintenance lock. If nothing is running '
        + 'now, the run that left that journal died while holding the lock — it never reached the code that '
        + `releases it. Make sure no maintenance command is running, remove the ${MAINTENANCE_LOCK_DIRNAME} `
        + 'directory in the project root, and resume. This command will not remove it for you: breaking a lock '
        + 'means guessing whether another process is alive, and a restore is the worst command to be wrong '
        + 'about that in. Nothing was changed.');
    }
    throw err;
  }
  try {
    // ---- NOTHING READ BEFORE THE LOCK MAY DRIVE AN EFFECT --------------------------------------------
    //
    // THE DEFECT THIS CLOSES. The journal was read once, OUTSIDE the lock, and that snapshot then supplied
    // the step states, the swap records and the evidence this run acted on. Between that read and the lock
    // being taken, another process holding the lock could complete the operation, clear the journal, or
    // unwind it with `--abandon` — and this run would proceed to place components and destroy volumes on
    // the strength of a description that had stopped being true.
    //
    // The journal is therefore RE-READ under the lock and required to be exactly what was read before it.
    // Anything else means somebody acted in between, and the honest answer is to stop and look again rather
    // than to reconcile two views of a half-finished restore.
    const underLock = readRestoreJournal(resolved.projectRoot);
    if (JSON.stringify(underLock) !== JSON.stringify(existing)) {
      throw new MaintenanceRefused(
        'this project\'s restore journal changed between reading it and taking the lock, so another command '
        + 'acted on this installation in between — it may have finished this restore, cleared it, or begun '
        + 'unwinding it. Nothing was changed. Look at the project and start again.');
    }

    // THE DIGEST IS RE-PROVED UNDER THE LOCK, over a FRESH verification of the set.
    const reResolved = existing === null
      ? resolveCompleteRestoreRequest(effective, probe)
      : { ...resolveCompleteRestoreRequest(effective, probe), targetState: existing.targetState };
    const rePlan = planCompleteRestore(reResolved, { safetySet, acceptDataLoss: plan.acceptDataLoss });
    if (rePlan.digest !== plan.digest) {
      throw new MaintenanceRefused(
        'the set or the installation changed between the plan and this run, so the plan no longer describes what '
        + 'would happen. Nothing was changed. Re-plan and read it again.');
    }

    // ---- THE JOURNAL AND THE SET MUST AGREE ABOUT WHAT WAS STAGED --------------------------------
    //
    // The commitment recorded before anything was destroyed is what an abandon deletes the staging tree on.
    // If it disagrees with the set now on disk, one of the two has been edited, and neither is safe to act
    // on: acting on the journal would authorise deleting a tree the set says is something else, and acting
    // on the set would let a swapped set redirect that deletion. The operation stops with nothing changed.
    if (existing !== null) {
      const declared = componentsOfManifest(reResolved.manifest);
      const recorded = existing.stagingCommitment;
      const agrees = recorded.length === declared.length && declared.every((component, index) => {
        const other = recorded[index]!;
        return other.id === component.id && other.artifact === component.artifact
          && other.digest === component.digest && other.entries === component.entries
          && other.bytes === component.bytes;
      });
      if (!agrees) {
        throw new MaintenanceRefused(
          'this journal records staged components that the set it names does not declare. One of the two has '
          + 'been edited since this operation started, and neither is safe to act on. Nothing was changed.');
      }
    }

    const write = deps.journalWriter ?? writeRestoreJournal;
    const currentJournal = (running: RestoreStepId | null = null): RestoreJournal => {
      void running;
      return {
        journal: 'catalog-authority.restore',
        version: RESTORE_JOURNAL_VERSION,
        planDigest: plan.digest,
        setName: resolved.setName,
        destination: resolved.destination,
        custodian: resolved.custodian,
        targetState: resolved.targetState,
        safetySetName: resolved.safetySetName,
        suffix,
        phase: 'restoring',
        safetySetClaim,
        safetySetPlanned: safetySet,
        safetySetTaken,
        stagingCommitment: componentsOfManifest(resolved.manifest),
        request: {
          secrets: resolved.secrets.relative,
          promotionRecords: resolved.promotionRecords?.relative ?? null,
          sidecarState: resolved.sidecarState?.relative ?? null,
        },
        steps: plan.steps.map((step) => state.get(step.id)!),
        swaps: swaps.map((swap) => ({ ...swap })),
        evidence: { custodyProven, safetySetTaken, safetySetVerified },
      };
    };
    const persist = (): void => { write(resolved.projectRoot, currentJournal()); };
    const mark = (id: RestoreStepId, next: JournalStepState, detail: string | null = null): void => {
      state.set(id, { id, state: next, detail });
      persist();
    };

    // ---- RECOVER THE STEP THE PROCESS DIED INSIDE ----------------------------------------------------
    //
    // -----------------------------------------------------------------------------------------------------
    // A `failed` EFFECTFUL STEP NEEDS RECOVERY EXACTLY AS MUCH AS A `running` ONE.
    // -----------------------------------------------------------------------------------------------------
    //
    // THE DEFECT THIS CLOSES. Recovery ran only for a step recorded `running` — a process that stopped
    // existing. But `performStep` can RETURN a failure after part of its effect has already landed, and the
    // executor then records `failed`; a resume marked that same step running and performed it again from the
    // top, with no recovery at all. Three of those are unsafe and two are dead ends:
    //
    //   * `psql` can exit non-zero having applied PART OF THE DUMP. Replaying the same dump onto that
    //     produces conflicts, not a restore — the very thing the `rewind` policy exists for, skipped because
    //     the step said "failed" instead of "running".
    //   * A SWAP whose second or third rename fails has already MOVED the staged component out of staging.
    //     Re-running the step finds no staged source and answers "the staged secrets directory is not
    //     there... re-run the staging step" — forever. The installation is left with its secrets directory
    //     missing or half-placed and a command that cannot move.
    //
    // So recovery is dispatched on whether the step's effect is AMBIGUOUS, not on which of two words the
    // journal happens to record. A `retry`-policy step is idempotent by declaration and needs none.
    const needsRecovery = (step: JournalStep): boolean => {
      if (step.state === 'running') return true;
      // A returned failure from a step whose effect cannot simply be repeated.
      return step.state === 'failed' && STEP_RECOVERY[step.id] !== 'retry';
    };
    const interrupted = plan.steps.map((step) => state.get(step.id)!).find(needsRecovery);
    if (interrupted !== undefined) {
      const recovery = recoverInterruptedStep(interrupted.id, resolved, plan, deps, stagingDir, suffix, swaps,
        safetySetClaim);
      if (recovery.kind === 'refuse') {
        // The journal keeps saying `running`, so the next attempt sees the same state rather than a state
        // this refusal invented.
        throw new MaintenanceRefused(recovery.detail);
      }
      for (const id of recovery.reset) state.set(id, { id, state: 'pending', detail: null });
      if (recovery.kind === 'complete') {
        state.set(interrupted.id, { id: interrupted.id, state: 'complete', detail: null });
        if (interrupted.id === 'stop-and-destroy') stopped = true;
        // A SWAP THAT LANDED AND WAS NEVER RECORDED IS RECONSTRUCTED, because `--abandon` walks that record
        // and a directory nothing names is a directory nothing can put back.
        if (recovery.swap !== undefined) swaps.push(recovery.swap);
        // THE EVIDENCE A RECOVERED STEP PRODUCED IS EVIDENCE THIS OPERATION HOLDS. The safety set was
        // VERIFIED to be recognised at all, and a report that then said "NONE TAKEN" would tell an operator
        // their installation is unrecoverable while the set sits in the project.
        if (interrupted.id === 'safety-set') { safetySetTaken = true; safetySetVerified = true; }
      }
      notes.push(recovery.note);
      persist();
    }

    for (const step of plan.steps) {
      const current = state.get(step.id)!;
      if (current.state === 'complete') {
        results.push({ id: step.id, proves: step.proves, outcome: 'skipped', detail: 'already completed by an earlier run' });
        continue;
      }
      if (failedAt !== null && !PROOF_STEP_IDS.includes(failedAt)) break;

      // INTENT BEFORE EFFECT. The journal says `running` before anything happens, so a process that dies
      // inside the step leaves a record naming it — which is the whole basis of the recovery above.
      mark(step.id, 'running');

      let detail: string | null;
      try {
        detail = performStep(step.id, resolved, plan, deps, stagingDir, suffix, {
          onSafetySet: (verified) => { safetySetTaken = true; safetySetVerified = verified; },
          onSwap: (swap) => {
            swaps.push(swap);
            // THE SWAP IS RECORDED THE INSTANT IT LANDS, not when the step returns. A crash between the
            // renames and the step's own completion must not lose which directory was moved aside.
            persist();
          },
          onStopped: () => { stopped = true; },
          onCustodyProven: (proven) => { custodyProven = proven; },
          onNote: (note) => { notes.push(note); },
          onClaim: (made) => { safetySetClaim = made; persist(); },
        }, safetySetClaim);
      } catch (err) {
        detail = err instanceof MaintenanceRefused
          ? err.message
          : 'this step failed for a reason this command does not have safe wording for';
      }

      if (detail !== null) {
        results.push({ id: step.id, proves: step.proves, outcome: 'failed', detail });
        mark(step.id, 'failed', detail);
        if (failedAt === null) { failedAt = step.id; failure = detail; }
        if (!PROOF_STEP_IDS.includes(step.id)) break;
        continue;
      }
      results.push({ id: step.id, proves: step.proves, outcome: 'held', detail: null });
      // EFFECT BEFORE RECORD. `complete` is written only after the step has actually done its work, so the
      // one thing a crash can never produce is a step recorded as done that did not happen.
      mark(step.id, 'complete');
    }

    // process completed, and a step it never touched is still a step that held — so the verdict is read off
    // the operation's own state rather than off what this loop happened to observe.
    const finalState = plan.steps.map((step) => state.get(step.id)!);
    const everyStepHeld = finalState.every((step) => step.state === 'complete');
    const firstFailure = finalState.find((step) => step.state === 'failed') ?? null;
    restoredButUnproven = firstFailure !== null
      && finalState.every((step) => step.state === 'complete' || PROOF_STEP_IDS.includes(step.id));

    if (everyStepHeld) {
      // ---- THE STAGING TREE HOLDS A COPY OF EVERY SECRET IN THE INSTALLATION -------------------------
      //
      // It is removed on success — but ONLY when it can be proved to be this operation's, by the marker it
      // carries. `removeOwnTreeNoFollow` refuses links and special files and would otherwise remove ANY
      // plain directory sitting at a name derived from a suffix an operator can read in a journal.
      //
      // AND IF IT CANNOT BE REMOVED, THE JOURNAL STAYS. Clearing it while a second copy of every secret sits
      // in the project would leave that copy named by nothing, in a project that has forgotten a restore
      // ever ran. The name is reported and this operation stays open instead.
      const removal = existsSync(stagingDir)
        ? removeOwnedStaging(stagingDir, currentJournal(), componentsOfManifest(resolved.manifest))
        : null;
      if (removal === null) {
        clearRestoreJournal(resolved.projectRoot);
        notes.push('The journal has been cleared: this restore completed and this project is not part way '
          + 'through one.');
      } else {
        stagingUnresolved = stagingDirName(suffix);
        notes.push(`The private staging directory could not be removed: ${removal} It holds a copy of this `
          + 'set\'s secrets and keystore. THE JOURNAL WAS NOT CLEARED, so this project keeps refusing a fresh '
          + 'restore until that copy is dealt with — it would otherwise be a second copy of every secret that '
          + 'nothing in this project names.');
      }
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

    report = {
      report: COMPLETE_RESTORE_REPORT,
      version: COMPLETE_RESTORE_VERSION,
      ok: everyStepHeld && stagingUnresolved === null,
      state: everyStepHeld ? 'RESTORED' : restoredButUnproven ? 'RESTORED_BUT_UNPROVEN' : 'INCOMPLETE',
      setName: resolved.setName,
      custodian: resolved.custodian,
      targetState: resolved.targetState,
      planDigest: plan.digest,
      safetySet: safetySetTaken && safetySetClaim !== null
        ? `${safetySetClaimDirName(safetySetClaim.nonce)}/${resolved.safetySetName}`
        : null,
      safetySetVerified,
      steps: results,
      replaced,
      custodyProven,
      stagingUnresolved,
      schemaVersion: MIGRATION_VERSION,
      network: 'none',
      mediaAccess: 'none',
      notes,
    };

  } finally {
    // THE LOCK IS RELEASED ONLY WHEN THE OPERATION IS OVER.
    //
    // THE DEFECT THIS CLOSES. The verdict, the staging cleanup and the journal clear all happened AFTER
    // this `finally`. Between the last step committing and the journal being cleared, this project held a
    // journal describing a COMPLETE operation and NO LOCK — so a resume could start against it, an abandon
    // could begin unwinding a restore that had just succeeded, and either would race the cleanup still
    // running here. The window was small, it was real, and every effect inside it is destructive.
    lock.release();
  }

  if (report === null) throw new MaintenanceRefused('this restore produced no report, which cannot happen');
  if (failure !== null && stopped && !restoredButUnproven) {
    throw new CompleteRestoreFailed(failure, failedAt, report);
  }
  return report;
}

/**
 * What a resume does about the one step a crash left `running`.
 *
 * `complete` — the effect is proved to have landed, or has been finished; the step is done.
 * `retry` — run it again, having reset the steps in `reset` to pending.
 * `refuse` — this is not a state a resume may act on, and the journal keeps saying so.
 */
export type StepRecovery =
  | { readonly kind: 'complete'; readonly reset: readonly RestoreStepId[]; readonly note: string;
      /** A swap that landed and was never recorded, reconstructed so `--abandon` can still undo it. */
      readonly swap?: JournalSwap }
  | { readonly kind: 'retry'; readonly reset: readonly RestoreStepId[]; readonly note: string }
  | { readonly kind: 'refuse'; readonly reset: readonly RestoreStepId[]; readonly detail: string; readonly note: string };

/**
 * Recover the step a process died inside, according to that step's declared policy.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHAT THE PREVIOUS MODEL COULD NOT DO.
 * -----------------------------------------------------------------------------------------------------
 *
 * It recorded a `running` step and then, on resume, simply ran it again. For most steps that is right. For
 * three of them it is not, and the three are the ones where it matters most:
 *
 *   * A SAFETY SET THAT WAS PUBLISHED AND NOT RECORDED. Re-running it hits `ops:complete-backup`'s refusal
 *     of an existing set name, so the resume could never get past its first step — the operator would be
 *     told to fix a "failed" backup that had in fact succeeded, and their only way forward would be to
 *     delete the very set protecting them.
 *   * A SWAP KILLED BETWEEN ITS TWO RENAMES. The target does not exist, the previous contents are under
 *     `.replaced-` and the new contents are under `.restoring-`. Re-running would copy the staged component
 *     to a `.restoring-` name that already exists and refuse. The installation would be stuck with NO
 *     secrets directory at all and a command that would not move.
 *   * A REPLAY KILLED HALFWAY. Nothing can repair a partial schema in place, and re-running the same dump
 *     over it produces conflicts, not a restore.
 *
 * Each of those has exactly one safe answer, and the answer is dispatched from `STEP_RECOVERY` rather than
 * from a reader's memory of which steps are idempotent.
 */
export function recoverInterruptedStep(
  id: RestoreStepId,
  resolved: ResolvedRestore,
  plan: RestorePlan,
  deps: CompleteRestoreDeps,
  stagingDir: string,
  suffix: string,
  swaps: readonly JournalSwap[],
  claim: SafetySetClaim | null,
): StepRecovery {
  const policy = STEP_RECOVERY[id];
  switch (policy) {
    case 'retry':
      return {
        kind: 'retry',
        reset: [id],
        note: `A previous run stopped inside "${id}". That step changes nothing that repeating it would `
          + 'damage, so it was simply run again.',
      };

    case 'confirm-or-retry': {
      // THE SAFETY SET: LOOK BEFORE REPEATING. A set of that name that is there and VERIFIES is the one the
      // interrupted run took — the whole cycle succeeded and only the record of it was lost.
      // THE QUESTION IS NOT "DOES A SET VERIFY". IT IS "IS THIS THE SET THIS OPERATION PUBLISHED". A set at
      // the operator's chosen base name is somebody else's — and a valid one sitting there is exactly what
      // would have made this run's own backup fail, which is why the old check mistook it for success.
      // NO CLAIM MEANS NOTHING OF OURS WAS EVER PUBLISHED. Whatever is in the destination belongs to
      // something else, and the run simply claims somewhere and takes its own.
      if (claim === null || !claim.created) {
        return {
          kind: 'retry',
          reset: [id],
          note: 'A previous run stopped while taking the safety set, before it had claimed anywhere to '
            + 'publish one. Nothing of this run\'s was published, so a fresh claim was made and the safety '
            + 'set taken. Any set already in that folder belongs to something else and was not touched.',
        };
      }
      const setDir = join(resolved.projectRoot, resolved.destination,
        safetySetClaimDirName(claim.nonce), resolved.safetySetName);
      if (!existsSync(setDir)) {
        return {
          kind: 'retry',
          reset: [id],
          note: 'A previous run claimed somewhere to publish the safety set and stopped before publishing '
            + 'one. The claim is still ours and still empty, so the set was taken into it. Any other set in '
            + 'that folder belongs to something else and was not touched.',
        };
      }
      const verification = verifyBackupSet(setDir);
      if (verification.ok) {
        return {
          kind: 'complete',
          reset: [],
          note: 'A previous run stopped after publishing the safety set but before recording it. The set is '
            + 'inside the directory THIS RUN created, under a nonce nothing else could guess, and it '
            + 'VERIFIES — so it is this run\'s and was not taken twice.',
        };
      }
      // A HALF-PUBLISHED SET UNDER A NAME NOBODY MAY REPLACE. This is the one case where a human has to
      // look: retaking is refused by the name, and trusting it is refused by the verification.
      return {
        kind: 'refuse',
        reset: [],
        detail: 'a previous run stopped while taking the safety set, and the set this operation publishes is '
          + 'here and does NOT verify. This command will not replace a backup set and will not trust one that does not '
          + 'verify. Move it aside deliberately, then resume. Nothing was changed.',
        note: 'The safety set from the interrupted run is present and does not verify.',
      };
    }

    case 'repair-swap': {
      const target = targetForStep(resolved, id);
      if (target === null) {
        return {
          kind: 'retry', reset: [id],
          note: `A previous run stopped inside "${id}", which this operation does not place; it was skipped.`,
        };
      }
      return repairSwap(target, stagingDir, componentForStep(id), suffix, deps, swaps, resolved.manifest);
    }

    case 'rewind': {
      // A PARTIAL REPLAY INVALIDATES THE WHOLE DATABASE LEG. The honest recovery is to run the leg again
      // rather than to guess how much of the dump landed.
      const to = STEP_REWIND_TO[id]!;
      const ids = plan.steps.map((step) => step.id);
      const from = ids.indexOf(to);
      const reset = from < 0 ? [id] : ids.slice(from, ids.indexOf(id) + 1);
      return {
        kind: 'retry',
        reset,
        note: `A previous run stopped inside "${id}", which cannot be repeated or repaired against a database `
          + 'holding part of a dump. The volumes are being destroyed and the whole database leg run again, '
          + 'which is the only recovery that leaves this installation somewhere describable.',
      };
    }
  }
}

/** Which target a placement step writes to, or `null` when this operation does not perform it. */
function targetForStep(resolved: ResolvedRestore, id: RestoreStepId): ResolvedTarget | null {
  if (id === 'place-secrets') return resolved.secrets;
  if (id === 'place-promotion-records') return resolved.promotionRecords;
  if (id === 'place-sidecar-keystore') return resolved.sidecarState;
  return null;
}

/** Which component a placement step places. */
function componentForStep(id: RestoreStepId): BackupComponentId {
  if (id === 'place-secrets') return 'secrets';
  if (id === 'place-promotion-records') return 'promotion-records';
  return 'keystore';
}

/**
 * Finish a swap that a crash caught part way through, or say why it cannot be finished.
 *
 * -----------------------------------------------------------------------------------------------------
 * THE SWAP IS THREE RENAMES NOW, AND THAT CHANGED WHAT A CRASH CAN LEAVE.
 * -----------------------------------------------------------------------------------------------------
 *
 * The verified staged component is MOVED to `.restoring-`, the target is moved to `.replaced-`, and the
 * in-flight copy is moved into place. Every intermediate state is distinguishable, and — critically — the
 * `.restoring-` directory is now THE ONLY COPY of that component outside the backup set. The previous
 * version DELETED it during recovery, which was safe while it was a second copy and would be destruction
 * now.
 *
 *   1. NOTHING MOVED — the staged component is still in staging. Run the step again.
 *   2. IN FLIGHT, TARGET INTACT — `.restoring-` exists and the target is untouched. Finish: move the target
 *      aside and the in-flight copy into place.
 *   3. IN FLIGHT, TARGET ALREADY ASIDE — `.restoring-` exists and the target is MISSING. The installation
 *      has no directory at that name at all. Finish the last rename.
 *   4. LANDED, UNRECORDED — the target holds the component and `.restoring-` is gone. Complete; the record
 *      is reconstructed so `--abandon` can still undo it.
 *
 * WHAT IS ABOUT TO BE INSTALLED IS RE-VERIFIED FIRST. An in-flight copy has been sitting at a predictable
 * name since another process died, for an unbounded time.
 */
function repairSwap(
  target: ResolvedTarget,
  stagingDir: string,
  id: BackupComponentId,
  suffix: string,
  deps: CompleteRestoreDeps,
  swaps: readonly JournalSwap[],
  manifest: BackupManifest,
): StepRecovery {
  const parent = join(target.dir, '..');
  const restoring = join(parent, swapStagingName(target.name, suffix));
  const replacedName = swapReplacedName(target.name, suffix);
  const replaced = join(parent, replacedName);
  const rename = deps.rename ?? renameSync;
  const already = swaps.some((swap) => swap.component === id);
  const record = (moved: boolean): JournalSwap => ({
    component: id, target: target.relative, name: target.name,
    replaced: moved ? replacedName : null, undone: false,
  });

  // ---- NOTHING IS IN FLIGHT: either it landed, or it never started ---------------------------------
  //
  // -----------------------------------------------------------------------------------------------------
  // "LANDED" IS DECIDED BY WHAT IS AT THE TARGET, NOT BY WHETHER A `.replaced-` EXISTS.
  // -----------------------------------------------------------------------------------------------------
  //
  // THE DEFECT THIS CLOSES. The landed-but-unrecorded case was recognised only when BOTH a `.replaced-`
  // directory and the target existed. That is the shape a swap leaves when the target was ALREADY THERE. When
  // the original target was ABSENT there is no `.replaced-` to find, so a completed swap leaves the target
  // present, nothing in flight and nothing kept aside — which the old recovery read as "nothing moved" and
  // retried. The retry then found the staged source gone (the placement had moved it) and answered "the
  // staged directory is not there, re-run the staging step", forever.
  //
  // AND "LANDED" IS VERIFIED, NOT ASSUMED. A directory at the target name is not evidence that this
  // operation put it there; it is compared against the component the backup manifest declares before this
  // command agrees the placement is done.
  if (!existsSync(restoring)) {
    if (existsSync(target.dir) && verifyStagedTree(target.dir, id, manifest) === null) {
      // It is exactly the component this set declares, so the placement completed and only the record was
      // lost. Whether a `.replaced-` exists tells us what the target was BEFORE, which is what an abandon
      // needs — an absent original is recorded as `replaced: null`, and absence is what abandon restores.
      const moved = existsSync(replaced);
      return {
        kind: 'complete',
        reset: [],
        ...(already ? {} : { swap: record(moved) }),
        note: `A previous run stopped after placing the ${target.name} directory but before recording it. `
          + 'Every rename had landed and the directory is the component this set declares, so the placement '
          + `is complete. ${moved
            ? 'The previous contents are beside it.'
            : 'There had been nothing at that name to keep, and an abandon will restore that absence.'}`,
      };
    }
    if (existsSync(replaced)) {
      return {
        kind: 'refuse', reset: [],
        detail: `a previous run left the ${target.name} directory missing, or holding something that is not `
          + 'the component this set declares, with its previous contents beside it and nothing in flight to '
          + 'put in its place. This command cannot tell what became of the replacement. Nothing was changed '
          + '— the previous contents are under the dot-prefixed name.',
        note: 'An unrecognisable swap state was found.',
      };
    }
    // NOTHING LANDED. That is only recoverable if the staged component is still there to place.
    if (!existsSync(join(stagingDir, COMPONENT_ARTIFACT_NAMES[id]))) {
      return {
        kind: 'refuse', reset: [],
        detail: `a previous run left neither a staged ${target.name} component, nor one in flight, nor one at `
          + 'the target that matches this set. This command has nothing verified to place and will not guess. '
          + 'Nothing was changed.',
        note: 'The staged component and every in-flight copy of it are gone.',
      };
    }
    return {
      kind: 'retry', reset: [],
      note: `A previous run stopped before the ${target.name} directory was moved, so nothing had changed `
        + 'and the placement was performed normally.',
    };
  }

  // ---- THE IN-FLIGHT COPY IS THE ONLY ONE, so it is proved to be the verified component before it lands.
  const problem = verifyStagedTree(restoring, id, manifest);
  if (problem !== null) {
    return {
      kind: 'refuse', reset: [],
      detail: `a previous run left an in-flight ${target.name} directory that is NOT the component this `
        + `set's manifest declares: ${problem}. It changed after it was verified, and this command will `
        + 'not install it. Nothing was changed.',
      note: 'An in-flight component no longer matched the manifest.',
    };
  }

  // ---- 2: in flight, target intact ----------------------------------------------------------------
  let moved = false;
  if (existsSync(target.dir)) {
    if (existsSync(replaced)) {
      return {
        kind: 'refuse', reset: [],
        detail: `a previous run left an in-flight, a kept-aside AND a current ${target.name} directory, `
          + 'which this command cannot have produced. Look at all three before running again. Nothing was '
          + 'changed.',
        note: 'An unrecognisable swap state was found.',
      };
    }
    try {
      rename(target.dir, replaced);
    } catch {
      return {
        kind: 'refuse', reset: [],
        detail: `a previous run left an in-flight ${target.name} directory and the current one could not be `
          + 'moved aside. Nothing was changed.',
        note: 'An interrupted swap could not be finished.',
      };
    }
    moved = true;
  } else {
    moved = existsSync(replaced);
  }

  // ---- 3: the last rename -------------------------------------------------------------------------
  try {
    rename(restoring, target.dir);
  } catch {
    return {
      kind: 'refuse', reset: [],
      detail: `a previous run left the ${target.name} directory missing and its replacement could not be `
        + 'moved into place. Nothing was changed — the data is all there under the dot-prefixed names.',
      note: 'An interrupted swap could not be finished.',
    };
  }
  return {
    kind: 'complete',
    reset: [],
    ...(already ? {} : { swap: record(moved) }),
    note: `A previous run was killed part way through placing the ${target.name} directory, leaving it `
      + 'MISSING or half-moved. The interrupted renames were finished against the RE-VERIFIED component, '
      + 'so the installation holds the restored contents and the previous ones are beside them.',
  };
}

/** Digest one directory and compare it to what the backup manifest declares for that component. */
function verifyStagedTree(path: string, id: BackupComponentId, manifest: BackupManifest): string | null {
  const declared = manifest.components.find((component) => component.id === id);
  if (declared === undefined || !declared.present) return `the manifest declares no ${id} component`;
  try {
    const actual = digestTreeAt(path, `in-flight ${id} component`);
    if (actual.digest !== declared.digest || actual.entries !== declared.entries
      || actual.bytes !== declared.bytes) {
      return 'its digest, entry count or size is not the one the manifest recorded';
    }
  } catch (err) {
    return err instanceof MaintenanceRefused ? err.message : 'it could not be examined';
  }
  return null;
}
interface StepHooks {
  readonly onSafetySet: (verified: boolean) => void;
  readonly onSwap: (swap: JournalSwap) => void;
  readonly onStopped: () => void;
  readonly onCustodyProven: (proven: boolean) => void;
  readonly onNote: (note: string) => void;
  /**
   * Record an exclusive claim, DURABLY, the instant `mkdir` returns and before anything is published into it.
   *
   * The ordering is the whole guarantee: a journal that says `created: true` means this run really created
   * that directory rather than found it, so a set inside it can only have been put there by this run.
   */
  readonly onClaim: (claim: SafetySetClaim) => void;
}

function performStep(
  id: RestoreStepId,
  resolved: ResolvedRestore,
  plan: RestorePlan,
  deps: CompleteRestoreDeps,
  stagingDir: string,
  suffix: string,
  hooks: StepHooks,
  claim: SafetySetClaim | null,
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
      // ---- CLAIM SOMEWHERE TO PUBLISH, EXCLUSIVELY, BEFORE PUBLISHING ANYTHING ---------------------
      //
      // `mkdir` both creates and refuses atomically, so it succeeds for exactly one party. A nonce from the
      // system CSPRNG makes the name unguessable, and recording `created: true` only after the call returned
      // makes "we created it" a fact rather than an inference. A directory that already exists is not ours,
      // whoever put it there — so the run draws another nonce instead of adopting it.
      let held = claim;
      if (held === null || !held.created) {
        let made: SafetySetClaim | null = null;
        for (let attempt = 0; attempt < 8 && made === null; attempt += 1) {
          const nonce = randomBytes(12).toString('hex');
          try {
            createPrivateDirectory(
              join(resolved.projectRoot, resolved.destination, safetySetClaimDirName(nonce)),
              'safety set claim directory');
            made = { nonce, created: true };
          } catch {
            // Occupied, or unwritable. Another nonce costs nothing and adopts nothing.
            made = null;
          }
        }
        if (made === null) {
          return 'somewhere to publish the safety set could not be claimed: the backup destination could not '
            + 'be written to. Nothing was destroyed.';
        }
        // DURABLE BEFORE PUBLICATION. This is the ordering the whole provenance rests on.
        hooks.onClaim(made);
        held = made;
      }
      const claimRelative = `${resolved.destination}/${safetySetClaimDirName(held.nonce)}`;

      let outcome: CompleteBackupOutcome;
      try {
        outcome = runVerifiedCompleteBackup({
          projectRoot: resolved.projectRoot,
          // PUBLISHED INSIDE THE CLAIM. "It is in a directory this run created, under a name nobody could
          // guess" is provenance a pre-existing set cannot have, however it is named.
          destination: claimRelative,
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
      return stageComponents(resolved, stagingDir, plan, suffix, deps.copier ?? realStagingCopier,
        deps.rename ?? renameSync);
    case 'stop-and-destroy': {
      hooks.onStopped();
      const outcome = runOne(step.commands[0]!);
      return outcome.status === 0 ? null : 'the stack could not be stopped and its volumes destroyed';
    }
    case 'place-secrets':
      return swapComponent(resolved.secrets, stagingDir, 'secrets', suffix, 'secrets directory', hooks.onSwap,
        deps.rename ?? renameSync, resolved.manifest);
    case 'place-promotion-records':
      return swapComponent(resolved.promotionRecords!, stagingDir, 'promotion-records', suffix,
        'promotion records directory', hooks.onSwap, deps.rename ?? renameSync, resolved.manifest);
    case 'place-sidecar-keystore':
      return swapComponent(resolved.sidecarState!, stagingDir, 'keystore', suffix,
        'sidecar state directory', hooks.onSwap, deps.rename ?? renameSync, resolved.manifest);
    case 'replay-database': {
      // THE STAGED DUMP, RE-VERIFIED THE INSTANT BEFORE IT IS REPLAYED. Staging happened before the
      // teardown, and on a resume it happened in another process, hours ago. A dump that changed in between
      // is a dump nothing has approved, and this is the last moment anything can say so.
      const stale = verifyStagedComponent(stagingDir, 'database', resolved.manifest);
      if (stale !== null) return stale;
      const dump = join(stagingDir, COMPONENT_ARTIFACT_NAMES.database);
      const outcome = runGuardedFromFile(deps.fileRunner, deps.ledger, materialise(step.commands[0]!), dump);
      // ---- AND VERIFIED AGAIN AFTER IT WAS CONSUMED ------------------------------------------------
      //
      // THE HOLE THIS CLOSES. Verifying and then handing a PATHNAME to another process proves what was
      // there a moment before `psql` opened it — nothing about what `psql` actually read. Anything that
      // rewrote the file inside that window was applied to the database, and this command would then have
      // gone on to boot the stack and run its proofs over it.
      //
      // A BOUND CHECK IS NOT A PERFECT ONE, and is not claimed to be: this cannot see what the child read.
      // What it can do is refuse to CARRY ON. If the bytes are no longer the ones the manifest declares,
      // what landed in that database is unknown — and an unknown database must never be booted, proved and
      // reported as a restore.
      const after = verifyStagedComponent(stagingDir, 'database', resolved.manifest);
      if (after !== null) {
        return `${after} — and it changed WHILE psql was reading it, so what is in that database now is `
          + 'unknown. This restore stops here rather than booting an installation nobody can describe.';
      }
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
    case 'place-inline-keystore': {
      // SAME RULE AS THE REPLAY: the container is about to read this tree, so it is proved to be the
      // verified one first.
      const stale = verifyStagedComponent(stagingDir, 'keystore', resolved.manifest);
      if (stale !== null) return stale;
      for (const command of step.commands) {
        const outcome = runOne(command);
        if (outcome.status !== 0) return failureSentence(id);
      }
      // SAME RULE AS THE REPLAY. `compose cp` reads a pathname; a tree rewritten while it copied would have
      // put key material into the volume this installation decrypts with that nothing ever approved.
      const afterCopy = verifyStagedComponent(stagingDir, 'keystore', resolved.manifest);
      if (afterCopy !== null) {
        return `${afterCopy} — and it changed WHILE it was being copied into the container, so what is in `
          + 'that keystore volume is unknown. This restore stops here rather than booting an installation '
          + 'whose key material nobody can describe.';
      }
      return null;
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
export const STAGING_MARKER_NAME = 'catalog-restore-staging.json';
export const STAGING_MARKER_VERSION = 1;

/**
 * What a staging directory says it is.
 *
 * -----------------------------------------------------------------------------------------------------
 * A PLAIN TREE AT THE EXPECTED NAME IS NOT OWNERSHIP.
 * -----------------------------------------------------------------------------------------------------
 *
 * The staging directory holds a copy of every secret in the installation, and its contents are what get
 * placed and replayed. The first version proved ownership of it with `removeOwnTreeNoFollow`, which refuses
 * links and special files — and would happily remove, or stage into, ANY plain directory sitting at the
 * expected name. The name is derived from a suffix recorded in a journal an operator can read.
 *
 * So the directory carries a marker binding it to THIS operation: the journal version it was written under,
 * the plan digest, the suffix, and what each staged component is supposed to be. Anything at that name
 * without a marker this build wrote, for this operation, is refused rather than trusted, reused or removed.
 */
export interface StagingMarker {
  readonly marker: 'catalog-authority.restore-staging';
  readonly version: typeof STAGING_MARKER_VERSION;
  readonly journalVersion: typeof RESTORE_JOURNAL_VERSION;
  readonly planDigest: string;
  readonly suffix: string;
  /**
   * `claimed` before a byte is copied; `sealed` once every component is copied AND verified.
   *
   * THE DEFECT THIS CLOSES. The marker was written LAST, so a process that died DURING the copy left an
   * UNMARKED tree at a predictable name — and the rule "an unmarked tree is not ours" then meant the resume
   * could neither trust it nor remove it. The project wedged: every resume refused, and the only way out was
   * an operator deleting a directory full of secrets by hand.
   *
   * A CLAIM COSTS NOTHING AND RESOLVES IT. Written before the copying starts, a partial tree carries proof of
   * whose it is, and may be removed and rebuilt by the operation that made it — and by nothing else.
   * `sealed` is what authorises USING the contents; `claimed` authorises only rebuilding them.
   */
  readonly state: StagingState;
  readonly components: readonly {
    readonly id: BackupComponentId;
    readonly artifact: string;
    readonly digest: string;
    readonly entries: number;
    readonly bytes: number;
  }[];
}

/** `claimed` — this operation is building it. `sealed` — every component is copied and verified. */
export type StagingState = 'claimed' | 'sealed';

export function stagingMarkerPath(stagingDir: string): string {
  return join(stagingDir, STAGING_MARKER_NAME);
}

/**
 * Read the marker of a staging directory and prove it is this operation's.
 *
 * Answers the marker, or a closed sentence saying why this directory is not ours. It opens the marker the
 * way every other file in this family is opened — without following a link, bounded — because a link at that
 * name is exactly how something would try to look like our staging directory.
 */
export function readStagingMarker(
  stagingDir: string,
  planDigest: string,
  suffix: string,
  expected: StagingMarker['components'],
): { readonly marker: StagingMarker } | { readonly refusal: string } {
  const path = stagingMarkerPath(stagingDir);
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
    return { refusal: 'there is a directory at this run\'s staging name that carries no ownership marker, so '
      + 'it is not one this command created. It was left alone.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileNoFollow(path, 'staging marker', 1024 * 1024).bytes.toString('utf8'));
  } catch {
    return { refusal: 'the ownership marker of this run\'s staging directory is not readable, so the directory '
      + 'cannot be proved to be this command\'s. It was left alone.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { refusal: 'the ownership marker of this run\'s staging directory is not one this build wrote.' };
  }
  const doc = parsed as Partial<StagingMarker>;
  if (doc.marker !== 'catalog-authority.restore-staging' || doc.version !== STAGING_MARKER_VERSION
    || doc.journalVersion !== RESTORE_JOURNAL_VERSION) {
    return { refusal: 'the ownership marker of this run\'s staging directory is not one this build wrote.' };
  }
  if (doc.planDigest !== planDigest || doc.suffix !== suffix) {
    // A MARKER FOR ANOTHER OPERATION. Removing it would destroy another restore's staged secrets.
    return { refusal: 'the directory at this run\'s staging name belongs to a DIFFERENT restore operation — '
      + 'its marker names another plan. It was left alone.' };
  }
  // -------------------------------------------------------------------------------------------------
  // A DOCUMENT THAT AUTHORISES RECURSIVE DELETION IS VALIDATED CANONICALLY.
  // -------------------------------------------------------------------------------------------------
  //
  // This marker decides whether a directory holding a copy of every secret in the installation may be
  // REMOVED AND REBUILT, and whether its contents may be placed into a live installation. A shape check that
  // only asked "is this an object naming the right plan" would let a malformed-but-matching document
  // authorise both. Every field is checked against a closed vocabulary, and against what the backup set
  // itself declares.
  const malformed = {
    refusal: 'the ownership marker of this run\'s staging directory is malformed, so it proves nothing and '
      + 'authorises nothing — least of all removing a directory of secrets. It was left alone.',
  };
  if (doc.state !== 'claimed' && doc.state !== 'sealed') return malformed;
  if (!Array.isArray(doc.components)) return malformed;
  const seen = new Set<string>();
  for (const entry of doc.components) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return malformed;
    const component = entry as Record<string, unknown>;
    // A KNOWN COMPONENT ID, exactly once.
    if (typeof component.id !== 'string'
      || !(BACKUP_COMPONENT_IDS as readonly string[]).includes(component.id)) return malformed;
    if (seen.has(component.id)) return malformed;
    seen.add(component.id);
    // THE CANONICAL ARTIFACT NAME FOR THAT ID, not any string.
    if (component.artifact !== COMPONENT_ARTIFACT_NAMES[component.id as BackupComponentId]) return malformed;
    // A SHA-256, spelled the one way this product spells one.
    if (typeof component.digest !== 'string' || !/^[0-9a-f]{64}$/.test(component.digest)) return malformed;
    // COUNTS THAT ARE COUNTS.
    for (const count of [component.entries, component.bytes]) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return malformed;
    }
  }
  // -------------------------------------------------------------------------------------------------
  // AND THE EXACT VALUES THE SET ITSELF DECLARES — ON EVERY READ, NOT SOME OF THEM.
  // -------------------------------------------------------------------------------------------------
  //
  // THE DEFECT THIS CLOSES. The manifest comparison was OPTIONAL, and the two paths that use this marker to
  // authorise a RECURSIVE DELETION — the rebuild of a partial stage, and the cleanup on success and on
  // abandon — were exactly the two that omitted it. A marker that named the right plan and the right suffix
  // but described a different set of components therefore authorised removing a tree of secrets. The
  // strictness was present, documented, and applied only where nothing was destroyed.
  //
  // It is a required argument now, so a caller cannot forget it, and the comparison is EXACT: same length,
  // same order, same ids, same digests, same counts. Missing, extra, duplicated, reordered or altered are
  // all the same answer — this marker does not describe what this operation staged, and it authorises
  // nothing.
  if (doc.components.length !== expected.length) return malformed;
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index]!;
    const got = doc.components[index]!;
    if (got.id !== want.id || got.artifact !== want.artifact || got.digest !== want.digest
      || got.entries !== want.entries || got.bytes !== want.bytes) return malformed;
  }
  return { marker: doc as StagingMarker };
}

/**
 * Prove one staged component is still exactly what the backup manifest declared.
 *
 * CALLED IMMEDIATELY BEFORE THE COMPONENT IS CONSUMED, every time, on every invocation. Staging happens once
 * and the components are consumed later — across steps, and after a resume, across processes and hours. A
 * verification that ran only at staging time would leave every window after it uncovered, and the artifact
 * sitting in those windows is the one that becomes the installation.
 */
export function verifyStagedComponent(
  stagingDir: string,
  id: BackupComponentId,
  manifest: BackupManifest,
): string | null {
  const declared = manifest.components.find((component) => component.id === id);
  if (declared === undefined || !declared.present) {
    return `the manifest of this set declares no ${id} component, so there is nothing verified to place`;
  }
  const path = join(stagingDir, COMPONENT_ARTIFACT_NAMES[id]);
  if (!existsSync(path)) return `the staged ${id} component is not there any more`;
  try {
    if (id === 'database') {
      const staged = digestFileNoFollow(path, `staged ${id} component`);
      if (staged.digest !== declared.digest || staged.size !== declared.bytes) {
        return `the staged ${id} component is no longer the one this set's manifest declares. It changed after `
          + 'it was staged and verified, and nothing this command holds is safe to place';
      }
      return null;
    }
    const staged = digestTreeAt(path, `staged ${id} component`);
    if (staged.digest !== declared.digest || staged.entries !== declared.entries
      || staged.bytes !== declared.bytes) {
      return `the staged ${id} component is no longer the one this set's manifest declares. It changed after `
        + 'it was staged and verified, and nothing this command holds is safe to place';
    }
  } catch (err) {
    return err instanceof MaintenanceRefused
      ? err.message
      : `the staged ${id} component could not be examined`;
  }
  return null;
}

/**
 * Prove the whole staging directory is ours and unchanged, for the components still expected in it.
 *
 * A component whose placement step has COMPLETED has been consumed and is legitimately gone; everything else
 * must still be exactly what the manifest declares.
 */
export function verifyOwnedStaging(
  stagingDir: string,
  plan: RestorePlan,
  suffix: string,
  manifest: BackupManifest,
  expected: readonly BackupComponentId[],
): string | null {
  const owned = readStagingMarker(stagingDir, plan.digest, suffix, componentsOfManifest(manifest));
  if ('refusal' in owned) return owned.refusal;
  if (owned.marker.state !== 'sealed') {
    return 'this run\'s staging directory is CLAIMED but not sealed: a previous process was still copying '
      + 'components into it when it stopped. Its contents are not verified and will not be used.';
  }
  for (const id of expected) {
    const problem = verifyStagedComponent(stagingDir, id, manifest);
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * Remove a staging tree, and ONLY one proved to be this operation's.
 *
 * The tree holds a copy of every secret in the installation, so leaving it is a real cost — and removing a
 * directory that is not ours is a worse one. A refusal answers a sentence; a removal answers `null`.
 */
export function removeOwnedStaging(
  stagingDir: string,
  journal: RestoreJournal,
  expected: StagingMarker['components'] = journal.stagingCommitment,
): string | null {
  const owned = readStagingMarker(stagingDir, journal.planDigest, journal.suffix, expected);
  if ('refusal' in owned) return owned.refusal;
  try {
    removeOwnTreeNoFollow(stagingDir, 'restore staging directory');
  } catch (err) {
    return err instanceof MaintenanceRefused ? err.message : 'it could not be removed.';
  }
  return null;
}

/**
 * Copy every component out of the set and RE-VERIFY the copy against the manifest.
 *
 * `verifyBackupSet` runs once, at resolution. Every placement afterwards would otherwise re-open the set BY
 * PATH, and a set that changed in between — an operator tidying up, a second process, a scheduled sync —
 * would supply bytes no verification had ever approved. Each component is staged once through the same
 * descriptor-safe reads every other copy in this family uses, and the STAGED object is re-digested against
 * the manifest's own recorded digest, entry count and byte count, BEFORE the teardown.
 *
 * The directory it produces carries an OWNERSHIP MARKER binding it to this operation, so nothing later
 * trusts, reuses or removes a plain tree merely because it sits at the expected name.
 */
export function stageComponents(
  resolved: ResolvedRestore,
  stagingDir: string,
  plan: RestorePlan,
  suffix: string,
  copier: StagingCopier = realStagingCopier,
  rename: Renamer = renameSync,
): string | null {
  if (existsSync(stagingDir)) {
    // A RESUME REACHES THIS ONLY IF THE STEP DID NOT COMPLETE, so a directory here is a partial stage from a
    // killed run — IF it is ours. One that is not ours is refused rather than removed: the name is derived
    // from a suffix an operator can read in a journal, and destroying somebody else's directory because it
    // sat at a predictable path is exactly the mistake this marker exists to prevent.
    // A CLAIMED TREE IS THIS OPERATION'S HALF-BUILT ONE and may be rebuilt; a SEALED one is also this
    // operation's and is equally safe to rebuild, because the set it came from is still there. What may
    // never be rebuilt is a tree whose marker does not prove it is ours — see `readStagingMarker`.
    const owned = readStagingMarker(stagingDir, plan.digest, suffix, componentsOfManifest(resolved.manifest));
    // AND THE REFUSAL NAMES IT. The directory is left in place, it may hold a copy of every secret in the
    // installation, and the name is derived from this operation rather than read out of anything — so
    // naming it costs no confidentiality and an operator who is not told cannot act.
    if ('refusal' in owned) {
      return `${owned.refusal} Nothing was destroyed: ${stagingDirName(suffix)} is still there, and it may `
        + 'hold a copy of this installation\'s secrets. Look at it before running again.';
    }
    try {
      removeOwnTreeNoFollow(stagingDir, 'restore staging directory');
    } catch {
      return 'a staging directory from an earlier attempt is here and could not be removed. Look at it before '
        + 'running again: this command will not stage into a directory it did not just create.';
    }
  }
  // ---- THE PREDICTABLE PATH NEVER EXISTS WITHOUT A VALID CLAIM ------------------------------------
  //
  // THE DEFECT THIS CLOSES. The claim marker was written INTO the staging directory after creating it, so a
  // process that died between the `mkdir` and that write left the predictable path holding an unmarked
  // directory — the exact wedge the claim protocol exists to eliminate, reintroduced two lines below the
  // comment explaining it.
  //
  // THE FIX IS AN ATOMIC PUBLICATION. A uniquely named directory is built somewhere nothing predicts, its
  // claimed marker is written INSIDE it while it is still invisible, and only then is it RENAMED onto the
  // predictable path. A rename is atomic, so the predictable path goes from "absent" to "a directory holding
  // a valid claimed marker" with no state in between. It is also SECRET-FREE while it is being built: not a
  // byte of any component is copied until after the publication.
  //
  // PROCESS DEATH VERSUS POWER LOSS. Against a process that stops existing this is exact: every intermediate
  // state is either the absent path or a fully claimed one, and the leftover build directory carries the
  // same marker, so it is recognisable and removable. Against a POWER LOSS it is not claimed: the rename's
  // metadata may not have reached the disk, because the containing directory is not fsynced afterwards. See
  // The staging directory is never visible without a valid claim, in
  // docs/PHASES_297_304_COMPLETE_RESTORE.md.
  const building = join(resolved.projectRoot, `.catalog-restore.claiming-${randomBytes(9).toString('hex')}`);
  createPrivateDirectory(building, 'restore staging claim');

  // ---- THE CLAIM, BEFORE A SINGLE BYTE IS COPIED --------------------------------------------------
  //
  // THE DEFECT THIS CLOSES. The marker used to be written LAST, so a process that died DURING the copy left
  // an UNMARKED tree at a predictable name — and "an unmarked tree is not ours" then meant the next resume
  // could neither trust it nor remove it. The project wedged: every resume refused, and the only way out was
  // an operator deleting a directory full of secrets by hand.
  //
  // A claim costs one small write and resolves it. A partial tree now carries proof of whose it is, so the
  // operation that made it may remove and rebuild it — and nothing else may.
  const claimed: StagingMarker['components'][number][] = componentsOfManifest(resolved.manifest);
  /**
   * Write a marker into `directory`, replacing any there ATOMICALLY.
   *
   * THE SECOND DEFECT THIS CLOSES. Sealing used to REMOVE the claimed marker and then write the sealed one.
   * A death in that gap left a populated, secret-bearing, UNMARKED tree — which the reader then refused
   * forever, and which nothing was allowed to remove. The window was two filesystem calls wide and it
   * undid the entire point of claiming.
   *
   * The complete marker is written to a private temporary file beside it and renamed over the top. A rename
   * replaces atomically, so a reader sees either the old valid marker or the new valid one; there is no
   * interval in which the marker is absent, and a death mid-way leaves the CLAIMED state, which is valid.
   */
  const writeMarker = (directory: string, state: StagingState): string | null => {
    const path = join(directory, STAGING_MARKER_NAME);
    const temporary = join(directory, `${STAGING_MARKER_NAME}.writing-${stagingSuffix()}`);
    try {
      writePrivateFile(temporary, `${JSON.stringify({
        marker: 'catalog-authority.restore-staging',
        version: STAGING_MARKER_VERSION,
        journalVersion: RESTORE_JOURNAL_VERSION,
        planDigest: plan.digest,
        suffix,
        state,
        components: claimed,
      } satisfies StagingMarker, null, 2)}\n`, 'staging marker');
      // ATOMIC REPLACE. Either the previous valid marker or this one — never neither.
      rename(temporary, path);
    } catch {
      return 'the staging directory\'s ownership marker could not be written, so nothing later could prove '
        + 'the staged components are this command\'s. Nothing was destroyed.';
    }
    return null;
  };
  const claimFailure = writeMarker(building, 'claimed');
  if (claimFailure !== null) return claimFailure;

  // ---- PUBLISH THE CLAIM ONTO THE PREDICTABLE PATH, ATOMICALLY ------------------------------------
  try {
    rename(building, stagingDir);
  } catch {
    return 'this run\'s staging directory could not be published at its own name. Nothing was destroyed — '
      + 'the half-built claim is beside it under a dot-prefixed name and carries this operation\'s marker.';
  }

  const staged: StagingMarker['components'][number][] = [];
  for (const id of BACKUP_COMPONENT_IDS) {
    const declared = resolved.manifest.components.find((component) => component.id === id);
    if (declared === undefined || !declared.present) continue;
    const artifact = COMPONENT_ARTIFACT_NAMES[id];
    const source = join(resolved.setDir, artifact);
    const destination = join(stagingDir, artifact);

    try {
      // STREAMED THROUGH A DESCRIPTOR for the dump — unbounded in file size, bounded in memory, refusing to
      // follow a link at the open — and a no-follow tree walk for the rest.
      copier(source, destination, id);
    } catch (err) {
      return err instanceof MaintenanceRefused
        ? `${err.message} Nothing was destroyed.`
        : `the ${id} component could not be staged. Nothing was destroyed.`;
    }
    const problem = verifyStagedComponent(stagingDir, id, resolved.manifest);
    if (problem !== null) {
      return `the ${id} component of this set is not the one the verification approved: what was copied out `
        + 'just now does not match what the manifest recorded. The set changed after it was verified. '
        + 'Nothing was destroyed.';
    }
    staged.push({
      id, artifact, digest: declared.digest, entries: declared.entries, bytes: declared.bytes,
    });
  }

  // ---- THE SEAL, ONCE EVERY COMPONENT IS COPIED AND VERIFIED -------------------------------------
  //
  // `claimed` says whose the tree is; `sealed` says its contents may be USED. Only a sealed tree
  // authorises a placement or a replay, so a kill part way through leaves a claimed tree that the same
  // operation rebuilds and no other operation may touch.
  if (staged.length !== claimed.length) {
    return 'the staging directory does not hold every component this set declares, so it was not sealed. '
      + 'Nothing was destroyed.';
  }
  return writeMarker(stagingDir, 'sealed');
}

/**
 * The components a manifest declares present, in the model's own order, as a marker records them.
 *
 * THIS IS THE COMMITMENT. Every path that lets a staging marker authorise a recursive deletion compares the
 * marker against one of these, value for value and position for position. A commitment derived from the
 * verified manifest and one read out of the journal must be identical, and the journal cross-checks them.
 */
export function componentsOfManifest(manifest: BackupManifest): StagingMarker['components'][number][] {
  return BACKUP_COMPONENT_IDS.flatMap((id) => {
    const declared = manifest.components.find((component) => component.id === id);
    if (declared === undefined || !declared.present) return [];
    return [{
      id,
      artifact: COMPONENT_ARTIFACT_NAMES[id],
      digest: declared.digest,
      entries: declared.entries,
      bytes: declared.bytes,
    }];
  });
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
  rename: Renamer,
  manifest: BackupManifest,
): string | null {
  const source = join(stagingDir, COMPONENT_ARTIFACT_NAMES[id]);
  if (!existsSync(source)) {
    return `the staged ${what} is not there, so this step has nothing verified to place. Re-run the staging step.`;
  }
  // VERIFIED THE INSTANT BEFORE IT IS CONSUMED. Between staging and here lies a teardown, several commands
  // and — on a resume — another process and an unbounded amount of time.
  const stale = verifyStagedComponent(stagingDir, id, manifest);
  if (stale !== null) return stale;
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
    return `a previous attempt left an in-flight or kept-aside ${what} beside this one. Look at them before `
      + 'running again: this command will not write into a name it did not just create.';
  }

  // ---- THE VERIFIED ARTIFACT IS MOVED, NOT COPIED AGAIN ---------------------------------------------
  //
  // THE DEFECT THIS CLOSES. This used to `copyTree` the staged component to the `.restoring-` name and
  // install THAT — a second copy, made after the verification and never checked itself. Anything that
  // touched it in the window between the copy and the rename would be installed unverified, and a partial
  // copy interrupted by a kill would leave a plausible-looking tree at a name the recovery trusts.
  //
  // A RENAME MOVES THE EXACT OBJECT THAT WAS JUST VERIFIED. There is no second copy to diverge, nothing to
  // re-check, and the staging directory legitimately no longer holds a component whose placement completed.
  rename(source, staging);
  let moved = false;
  if (existsSync(target.dir)) {
    try {
      // THE FIRST RENAME. From here until the second one lands, the installation has NO directory at this
      // name — which is why the journal already records this step as running, and why the recovery knows
      // how to finish what a crash here interrupts.
      rename(target.dir, replaced);
    } catch {
      return `the existing ${what} could not be moved aside, so nothing was replaced`;
    }
    moved = true;
  }
  try {
    rename(staging, target.dir);
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
  /** Targets whose ORIGINAL state — present with its old contents, or absent — has been restored. */
  readonly restored: readonly string[];
  /** Swaps this run could not put back. The journal is NOT cleared while any of these remain. */
  readonly unresolved: readonly string[];
  /**
   * Every copy this abandon set aside and kept, by name.
   *
   * THE DEFECT THIS CLOSES. When the original target was ABSENT, the first version had nothing to rename
   * back, marked the swap undone and left the RESTORED copy sitting at the target — so an abandon reported
   * success having restored nothing, and left a directory of the set's secrets at a path the installation
   * had never had. Absence is a state like any other and putting it back is part of the job; the restored
   * copy is moved to a deterministic `.abandoned-` name and that name is reported, because it holds secrets
   * and nothing else would ever mention it.
   */
  readonly retained: readonly string[];
  readonly journalCleared: boolean;
  /** The staging directory, when it could not be proved ours and removed. Named because it holds secrets. */
  readonly stagingUnresolved: string | null;
  readonly notes: readonly string[];
}

/**
 * Put the host state back the way this operation found it, and clear the journal only when all of it is.
 *
 * -----------------------------------------------------------------------------------------------------
 * IT TAKES THE PROJECT ROOT AND NOTHING ELSE.
 * -----------------------------------------------------------------------------------------------------
 *
 * An earlier version re-derived the targets from the CLI's own path flags, which can differ from the ones
 * the interrupted run actually swapped; it would then find no `.replaced-` directory, report success with
 * nothing put back, and CLEAR THE JOURNAL — orphaning the real directories. The journal carries the
 * operation's own targets and they are what this walks.
 *
 * EVERY SWAP IS CROSS-VALIDATED BEFORE IT IS ACTED ON. A journal is a file in a directory an operator owns,
 * and this function renames directories on the strength of it. So each recorded swap must agree with the
 * rest of the journal in every way it can: the component must be one this operation's TOPOLOGY places on the
 * host, its placement step must be one of this operation's steps, the target must be the relative path the
 * journal's own request records for that component, the leaf must be that path's last segment, and both the
 * `.replaced-` and `.abandoned-` names must be the ones this suffix derives. A swap that fails any of them
 * cannot redirect this command at another directory in the project.
 *
 * IT RUNS UNDER THE PROJECT'S MAINTENANCE LOCK. Abandon renames directories, removes a staging tree and
 * clears the journal; doing any of that while a resume is running against the same journal is the same race
 * the restore itself takes the lock to prevent.
 */
export function abandonRestore(projectRootRequested: string, deps: AbandonDeps = {}): AbandonReport {
  const projectRoot = resolveMaintenanceRoot(projectRootRequested, 'project root');
  const preLock = readRestoreJournal(projectRoot);
  if (preLock === null) {
    throw new MaintenanceRefused('there is no restore to abandon in this project: no journal is here.');
  }

  let lock;
  try {
    lock = acquireMaintenanceLock(projectRoot);
  } catch {
    throw new MaintenanceRefused(
      'this project holds BOTH an interrupted restore journal and a maintenance lock. If nothing is running '
      + 'now, the run that left that journal died while holding the lock — it never reached the code that '
      + `releases it. Make sure no maintenance command is running, remove the ${MAINTENANCE_LOCK_DIRNAME} `
      + 'directory in the project root, and abandon again. This command will not remove it for you. Nothing '
      + 'was changed.');
  }

  try {
    // NOTHING READ BEFORE THE LOCK MAY DRIVE AN EFFECT. Same rule as the restore's own: a journal that
    // changed in between means somebody acted, and acting on the older view would undo their work.
    const journal = readRestoreJournal(projectRoot);
    if (JSON.stringify(journal) !== JSON.stringify(preLock)) {
      throw new MaintenanceRefused(
        'this project\'s restore journal changed between reading it and taking the lock, so another command '
        + 'acted on this installation in between. Nothing was changed.');
    }
    if (journal === null) {
      throw new MaintenanceRefused('there is no restore to abandon in this project: no journal is here.');
    }
    return abandonUnderLock(projectRoot, journal, deps);
  } finally {
    lock.release();
  }
}

export interface AbandonDeps {
  readonly rename?: Renamer;
  readonly journalWriter?: JournalWriter;
}

function abandonUnderLock(projectRoot: string, journal: RestoreJournal, deps: AbandonDeps): AbandonReport {
  const rename = deps.rename ?? renameSync;
  const write = deps.journalWriter ?? writeRestoreJournal;
  const restored: string[] = [];
  const unresolved: string[] = [];
  const retained: string[] = [];
  const notes: string[] = [];
  const swaps = journal.swaps.map((swap) => ({ ...swap }));

  // ---- THE DIRECTION IS RECORDED BEFORE THE FIRST RENAME -------------------------------------------
  //
  // Everything below renames directories. If this process dies part way through, what is on disk is a
  // half-unwound installation — and until this write lands, nothing in the project says an unwind was ever
  // asked for, so the next `--resume` would read the restore's own step states and rebuild the restore on
  // top of it. The phase is written first, and it is exclusive from that moment.
  if (journal.phase !== 'abandoning') {
    write(projectRoot, { ...journal, phase: 'abandoning' });
  }
  const abandoning: RestoreJournal = { ...journal, phase: 'abandoning' };

  for (const swap of swaps) {
    if (swap.undone) {
      // ALREADY PUT BACK BY AN EARLIER ATTEMPT — and every copy it set aside is still named, because those
      // hold secrets whether or not THIS invocation is the one that moved them.
      //
      // THE DEFECT THIS CLOSES. Only the `replaced === null` case was reported. A swap whose original target
      // HAD existed leaves an `.abandoned-` copy too, and an earlier attempt that finished it left that copy
      // on disk with nothing naming it — a directory of the installation's secrets that no report mentioned.
      // Existence on disk is what decides, not which branch created it.
      let dir: string | null = null;
      try {
        dir = resolveInsideRoot(projectRoot, swap.target, `${swap.component} target`);
      } catch { dir = null; }
      if (dir !== null && existsSync(join(join(dir, '..'), abandonedName(swap, journal.suffix)))) {
        retained.push(abandonedName(swap, journal.suffix));
      }
      continue;
    }

    // ---- THE SWAP MUST AGREE WITH THE REST OF THE JOURNAL BEFORE IT MOVES ANYTHING -------------------
    const complaint = swapDisagreement(swap, journal);
    if (complaint !== null) {
      unresolved.push(swap.name);
      notes.push(`A recorded swap of the ${swap.component} component does not agree with this operation: `
        + `${complaint}. It was left alone.`);
      continue;
    }

    let dir: string;
    try {
      dir = resolveInsideRoot(projectRoot, swap.target, `${swap.component} target`);
    } catch {
      unresolved.push(swap.name);
      continue;
    }
    const parent = join(dir, '..');
    const abandoned = join(parent, abandonedName(swap, journal.suffix));
    const replacedPath = swap.replaced === null ? null : join(parent, swap.replaced);

    // ---- 0. DID AN EARLIER ATTEMPT ALREADY FINISH THIS ONE? -------------------------------------------
    //
    // A CRASH BETWEEN THE LAST RENAME AND THE JOURNAL WRITE leaves a swap that is fully unwound and recorded
    // as not. Re-running it blindly would move the RESTORED-TO-ORIGINAL directory aside a second time and
    // fail on an abandoned name that already exists — turning a finished unwind into an unresolved one.
    const finishedAlready = replacedPath === null
      ? !existsSync(dir) && existsSync(abandoned)
      : existsSync(dir) && existsSync(abandoned) && !existsSync(replacedPath);
    if (finishedAlready) {
      swap.undone = true;
      restored.push(swap.name);
      retained.push(abandonedName(swap, journal.suffix));
      continue;
    }

    // ---- 1. MOVE THE RESTORED COPY ASIDE -------------------------------------------------------------
    //
    // NOT DELETED. This command does not destroy the only copy of anything, and an operator who abandons and
    // then changes their mind still holds both. A crash between this rename and the next is recoverable
    // because the state it leaves is distinguishable: the target is absent and the abandoned name exists.
    if (existsSync(dir)) {
      if (existsSync(abandoned)) {
        unresolved.push(swap.name);
        notes.push(`Both a restored and an abandoned ${swap.name} directory are here, which this command `
          + 'cannot have produced. It was left alone.');
        continue;
      }
      try {
        rename(dir, abandoned);
      } catch {
        unresolved.push(swap.name);
        continue;
      }
    }
    if (existsSync(abandoned)) retained.push(abandonedName(swap, journal.suffix));

    // ---- 2. PUT THE ORIGINAL STATE BACK ---------------------------------------------------------------
    if (swap.replaced === null) {
      // THE TARGET DID NOT EXIST BEFORE THIS OPERATION, so putting it back means leaving it ABSENT. The
      // first version marked this undone and left the restored copy in place, which restored nothing.
      if (existsSync(dir)) { unresolved.push(swap.name); continue; }
      swap.undone = true;
      restored.push(swap.name);
      continue;
    }
    const replaced = join(parent, swap.replaced);
    if (!existsSync(replaced)) {
      // A CRASH AFTER `replaced` WAS RENAMED BACK looks exactly like this, and is told apart by the target:
      // if the target is there and the abandoned copy is too, the previous attempt finished this swap.
      if (existsSync(dir) && existsSync(abandoned)) { swap.undone = true; restored.push(swap.name); continue; }
      unresolved.push(swap.name);
      continue;
    }
    if (lstatSync(replaced).isSymbolicLink() || !statSync(replaced).isDirectory()) {
      unresolved.push(swap.name);
      notes.push(`What this restore moved aside for ${swap.name} is no longer a plain directory. It was left alone.`);
      continue;
    }
    try {
      rename(replaced, dir);
    } catch {
      unresolved.push(swap.name);
      continue;
    }
    swap.undone = true;
    restored.push(swap.name);
  }

  // ---- 3. THE STAGING TREE, WHICH HOLDS A COPY OF EVERY SECRET IN THE INSTALLATION --------------------
  // AND IT IS NOT REMOVED WHILE ANYTHING IS STILL OUT OF PLACE. The staged components are the only verified
  // copies this operation holds; a swap that could not be put back may yet need them, and a project that is
  // still half-unwound is not one to be tidying up in.
  const stagingDir = join(projectRoot, stagingDirName(journal.suffix));
  let stagingUnresolved: string | null = null;
  if (unresolved.length > 0 && existsSync(stagingDir)) {
    stagingUnresolved = stagingDirName(journal.suffix);
    notes.push('The staging directory was left in place because something this restore moved is still out '
      + 'of place. It holds a copy of the set\'s secrets and keystore.');
  } else if (existsSync(stagingDir)) {
    const removal = removeOwnedStaging(stagingDir, journal);
    if (removal !== null) {
      stagingUnresolved = stagingDirName(journal.suffix);
      notes.push(`The staging directory could not be removed: ${removal} It holds a copy of this set's `
        + 'secrets and keystore.');
    }
  }

  // ---- 4. THE JOURNAL GOES ONLY WHEN EVERYTHING IS BACK ----------------------------------------------
  const journalCleared = unresolved.length === 0 && stagingUnresolved === null;
  if (journalCleared) {
    clearRestoreJournal(projectRoot);
    notes.push('The journal has been cleared, so this project accepts a restore again.');
  } else {
    // A PARTIAL UNWIND MUST STAY VISIBLE. A project with an unresolved swap or an unremoved staging tree
    // keeps refusing a fresh restore: running one would take a "safety set" of a half-unwound installation.
    write(projectRoot, { ...abandoning, swaps });
    notes.push('THE JOURNAL WAS NOT CLEARED: something this restore moved, or the staging copy of your '
      + 'secrets, is still out of place. This project keeps refusing a fresh restore until it is not.');
  }
  if (retained.length > 0) {
    notes.push('The copies this abandon set aside are listed above. They hold secret material: destroy them '
      + 'the way you would destroy a password, once you are done.');
  }
  notes.push('The host directories this restore swapped are back the way it found them. THE DATABASE AND, IN '
    + 'INLINE CUSTODY, THE KEYSTORE WERE DESTROYED BY THE TEARDOWN AND ARE NOT COMING BACK FROM A RENAME. '
    + 'Restore the safety set to get them.');
  return {
    report: 'phase-303-restore-abandon',
    ok: journalCleared,
    setName: journal.setName,
    restored,
    unresolved,
    retained,
    journalCleared,
    stagingUnresolved,
    notes,
  };
}

/** The deterministic name the restored copy is set aside under. Derived, never taken from the journal. */
export function abandonedName(swap: JournalSwap, suffix: string): string {
  return `.${swap.name}.abandoned-${suffix}`;
}

/**
 * Why this recorded swap cannot be acted on, or `null` when it agrees with the rest of the journal.
 *
 * A CORRUPT SWAP MUST NOT REDIRECT AN ABANDON AT ANOTHER DIRECTORY. Every field is checked against something
 * else the journal already says, so a swap can only ever name the place this operation actually placed that
 * component.
 */
export function swapDisagreement(swap: JournalSwap, journal: RestoreJournal): string | null {
  const expectedTarget = swap.component === 'secrets' ? journal.request.secrets
    : swap.component === 'promotion-records' ? journal.request.promotionRecords
      : swap.component === 'keystore' ? journal.request.sidecarState
        : null;
  if (expectedTarget === null) {
    return `this operation places no ${swap.component} component on the host`;
  }
  if (swap.target !== expectedTarget) return 'its target is not the one this operation was planned with';
  if (swap.component === 'keystore' && journal.custodian !== 'sidecar') {
    return 'a keystore is only placed on the host in sidecar custody, and this operation is not';
  }
  const step = swap.component === 'secrets' ? 'place-secrets'
    : swap.component === 'promotion-records' ? 'place-promotion-records' : 'place-sidecar-keystore';
  if (!journal.steps.some((entry) => entry.id === step)) {
    return `this operation has no ${step} step`;
  }
  const leaf = expectedTarget.split(/[\\/]/).filter((part) => part !== '' && part !== '.').pop();
  if (leaf !== swap.name) return 'its leaf name is not the last segment of its own target';
  if (swap.replaced !== null && swap.replaced !== swapReplacedName(swap.name, journal.suffix)) {
    return 'its kept-aside name is not one this run\'s suffix derives';
  }
  return null;
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
    ? `  a verified safety set would be taken first, named "${resolved.safetySetName}", inside a directory `
      + 'this run claims exclusively with mkdir under an unguessable nonce — so a resume can prove the set '
      + 'it finds was published by this run and not merely that something valid sits at a predictable name'
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
