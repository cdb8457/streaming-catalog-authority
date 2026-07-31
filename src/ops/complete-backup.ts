import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import { MAX_ROOT_KEY_FILE_BYTES, decodeKey } from '../core/crypto/kek-ring.js';
import {
  BACKUP_COMPONENT_IDS,
  COMPONENT_ARTIFACT_NAMES,
  REQUIRED_SECRET_FILES,
  ROOT_KEY_SECRET_NAME,
  backupSetHasRing,
  requiredSecretFilesFor,
  type BackupComponentId,
} from './backup-components.js';
import { REQUIRED_COMPONENTS as INSPECTOR_REQUIRED_COMPONENTS } from './backup-inspect.js';
import {
  CommandLedger,
  MaintenanceLocks,
  MaintenanceRefused,
  assertHeldDestination,
  assertNotSafetyClaimNamespace,
  assertPlainTree,
  assertUsableName,
  createPrivateDirectory,
  provePhysicalDestination,
  publishDirectory,
  resolveInsideRoot,
  resolveMaintenanceRoot,
  assertDirectoryNoFollow,
  digestFileNoFollow,
  fileSizeNoFollow,
  readFileNoFollow,
  runGuarded,
  runGuardedToFile,
  stagingSuffix,
  writePrivateFile,
  type CommandRunner,
  type FileOutputRunner,
  type HeldDestination,
  type MaintenanceCommand,
} from './maintenance-safety.js';
import { verifyBackupSet, type BackupVerificationReport } from './backup-set-verification.js';

// Phase 277 — taking the backup the product has always described, without describing it a second time.
//
// WHAT WAS MISSING. Phase 256 established what a complete backup IS — four components, none of them
// obtainable again — and Phase 257 built an offline inspector for one. Between them there was still only
// prose: an operator read four commands off a page and ran them by hand, in an order that matters, with a
// quiescence step that is easy to skip and invisible when you do. `ops:backup` exists and is a DIFFERENT
// thing: the Phase 3 ciphertext-only database artifact, which is one component of four.
//
// SO THIS COMPOSES, IT DOES NOT REDEFINE. The component list is `backup-components.ts`'s. The secret file
// names are its `REQUIRED_SECRET_FILES`. The verification afterwards is Phase 257's `inspectBackupDirectory`,
// run through the shipped offline inspector. There is no second answer to "what is a complete backup" in this
// file, and a component added to the model appears here without being retyped.
//
// -----------------------------------------------------------------------------------------------------
// THE DATABASE AND THE KEYSTORE MUST COME FROM THE SAME MOMENT.
// -----------------------------------------------------------------------------------------------------
//
// This is the property the whole command is built around. A dump taken while the app was writing, and a
// keystore copied a few seconds later, produce a backup that restores into an installation which cannot read
// some of its own rows — and which reports itself healthy, because a fail-closed unreadable item looks
// exactly like a correctly erased one. So every writer is STOPPED first, both components are taken while
// nothing can write, and the writers are started again through a `finally` that runs on every path out,
// including a refusal, a thrown error and a failed step. A backup that leaves the stack down is a backup that
// causes the outage it was insurance against.
//
// PostgreSQL itself stays UP. It is the thing being dumped; stopping it would mean dumping nothing. What is
// stopped is everything that WRITES: the app, and the custodian sidecar when the topology has one.
//
// -----------------------------------------------------------------------------------------------------
// TOPOLOGY IS DECLARED, NEVER GUESSED.
// -----------------------------------------------------------------------------------------------------
//
// The keystore lives in one of two places depending on how the operator deployed: inside the app container
// (inline `FileCustodian`) or in a sidecar's own state directory. Guessing between them is how a backup ends
// up with an empty keystore directory and a green result. `--custodian inline` copies from the app container;
// `--custodian sidecar --sidecar-state <relative path>` copies a directory the operator names, inside the
// project root, checked. There is no default and no probe: an unstated topology is a refusal.
//
// NO MEDIA PATH IS ACCEPTED OR INSPECTED. Nothing here takes a library path, and `maintenance-safety.ts`
// refuses any argument that looks like one. The import folder is deliberately NOT a component — Phase 256
// excludes it as operator-supplied input, and this command honours that exclusion rather than re-deciding it.

export const COMPLETE_BACKUP_REPORT = 'phase-277-complete-backup';
export const COMPLETE_BACKUP_VERSION = 1;

/** The file the set carries describing itself. Structural metadata and digests; never content. */
export const BACKUP_MANIFEST_NAME = 'catalog-backup-manifest.json';
export const BACKUP_MANIFEST_VERSION = 1;

/** What each component is called inside a published set. Fixed, so the inspector and a restore both know. */
export { COMPONENT_ARTIFACT_NAMES };

/**
 * The components a set MUST hold to be a backup at all.
 *
 * Deliberately the same three Phase 257's inspector requires, imported rather than retyped: promotion records
 * are advisory because an empty records folder is a correct and permanent state for most installations. The
 * SLOT is still manifested for all four — absence is recorded, never omitted.
 */
export const REQUIRED_COMPONENT_IDS: readonly BackupComponentId[] = INSPECTOR_REQUIRED_COMPONENTS;

export type CustodianTopology = 'inline' | 'sidecar';

/** Services that must not be writing while the database and the keystore are taken. */
export const QUIESCED_SERVICES: Readonly<Record<CustodianTopology, readonly string[]>> = Object.freeze({
  inline: Object.freeze(['app']),
  sidecar: Object.freeze(['app', 'sidecar']),
});

export interface CompleteBackupRequest {
  /** The Compose project directory, absolute. Resolved and proved to be a real, contained, non-broad root. */
  readonly projectRoot: string;
  /** Where sets are written, relative to the project root. Created private if it does not exist. */
  readonly destination: string;
  /** The name of THIS set, inside the destination. Refused if it already exists. */
  readonly setName: string;
  readonly custodian: CustodianTopology;
  /**
   * The sidecar's state directory, relative to the project root. REQUIRED in sidecar mode and refused in
   * inline mode: a path that is ignored is a path somebody will believe was used.
   */
  readonly sidecarState?: string;
  /** The promotion-records directory, relative to the project root. Absent means the installation has none. */
  readonly promotionRecords?: string;
  /** The secrets directory, relative to the project root. */
  readonly secrets: string;
}

export interface BackupComponentResult {
  readonly id: BackupComponentId;
  /** The name inside the set. A base name, never a path. */
  readonly artifact: string;
  readonly present: boolean;
  readonly bytes: number;
  readonly entries: number;
  /** sha256 over the component's bytes, or over a canonical listing for a directory. Names no content. */
  readonly digest: string;
}

/**
 * What was taken. A DESCRIPTION, AND DELIBERATELY NOT A VERDICT.
 *
 * THE DEFECT THIS CLOSES. This report used to carry `ok`, and `ok` was the conjunction of "the set was taken"
 * and "the stack came back" — but NOT of "the set verifies". Any caller holding one of these could read a
 * `true` there and stop, and the only thing standing between an unverified success and a verified one was
 * that the CLI happened to call the verification afterwards. Removing the field removes the path: there is no
 * `ok` on this type to read, and the only `ok` this module produces is `CompleteBackupOutcome`'s, which cannot
 * exist without a verification beside it.
 */
export interface CompleteBackupReport {
  readonly report: typeof COMPLETE_BACKUP_REPORT;
  readonly version: typeof COMPLETE_BACKUP_VERSION;
  /** Whether a complete set reached its final name. A failed restart does not un-publish a good set. */
  readonly published: boolean;
  /** The set's own name. The operator chose it; it is not a path. */
  readonly setName: string;
  readonly custodian: CustodianTopology;
  readonly components: readonly BackupComponentResult[];
  /** Services stopped for the consistent window, and whether they were started again. */
  readonly quiesced: readonly string[];
  readonly restarted: boolean;
  /** The ones that did NOT start again, so an outage is a named fact rather than a sentence in a note. */
  readonly stillStopped: readonly string[];
  readonly schemaVersion: number;
  /** A digest over the manifest, so two reports of one set are comparable without reading it. */
  readonly manifestDigest: string;
  readonly network: 'none';
  readonly mediaAccess: 'none';
  readonly notes: readonly string[];
}

export interface CompleteBackupDeps {
  /**
   * The destination must ALREADY EXIST, and this command must not create it.
   *
   * THE ONE CALLER THAT SETS IT is the restore publishing its safety set into a directory it claimed by
   * `mkdir` — where creating the directory IS the claim. If that directory has since been removed, then
   * the claim is void and the recovery has already decided to abandon the nonce; a backup that quietly
   * recreated the path would take this installation's only safety net into a directory nothing owns, at a
   * path written down in a file in the project, behind the recovery's back.
   */
  readonly requireExistingDestination?: boolean;
  readonly runner: CommandRunner;
  /** The runner that binds a child's stdout to a file. The database dump is the only user of it. */
  readonly fileRunner: FileOutputRunner;
  readonly ledger: CommandLedger;
  /** Injected so a suite can produce a set with a fixed timestamp. Never used for a name or a decision. */
  readonly now?: () => Date;
  /**
   * PROOF that the caller already holds both locks covering this backup, so take neither. Phase 300, widened
   * in 321-328, and made non-forgeable in Correction 1.
   *
   * THERE IS EXACTLY ONE LEGITIMATE CALLER AND IT IS NAMED: `ops:complete-restore`, taking the safety set of
   * the installation it is about to destroy, into a claim directory INSIDE the destination it is holding.
   * The alternative — taking that set before acquiring the restore's own locks — would leave a window in
   * which another maintenance command could act between the safety set and the `down -v`, which is precisely
   * the interleaving the locks exist to prevent.
   *
   * IT COVERS THE DESTINATION LOCK TOO, and it has to. The restore holds the destination lock on the BACKUP
   * DESTINATION; this backup publishes into a claim directory inside it. A destination lock taken here would
   * be a lock on the claim directory — a different directory, excluding nothing that matters — and it would
   * put a lock directory inside a claim whose contents are later proved entry by entry.
   *
   * WHAT CORRECTION 1 CHANGED. This used to be a `holdingLock` boolean. A boolean names no project, no
   * destination and no holder, so any caller could set it and suppress BOTH locks for ANY project and ANY
   * destination; the only thing standing between that and an unlocked backup was a suite grepping `src/` for
   * the word, which is a lint rule and not an authority. A `HeldDestination` can only be minted by a
   * `MaintenanceLocks` that is really holding both, is bound to that project and that physical destination,
   * is refused at runtime if it was forged by a cast, and stops authorising anything the moment its owner
   * releases. It is validated BEFORE this command creates a directory, writes anything or runs a child.
   */
  readonly held?: HeldDestination;
  /**
   * Named boundaries a suite can stop a real process at. Production passes nothing and this does nothing.
   *
   * It exists for one property that cannot be observed any other way: that the locks are still held AFTER
   * the set is published and BEFORE its verification verdict exists. See `runVerifiedCompleteBackup`.
   */
  readonly at?: (point: CompleteBackupFailpoint) => void;
}

/**
 * Validate a request into resolved, proved paths.
 *
 * SEPARATE FROM RUNNING IT, so a suite — and `--plan` — can see exactly what would happen without a service
 * being stopped. Every refusal in this function happens before anything is created and before any service is
 * touched.
 */
/**
 * Where a suite may stop a real process, by name.
 *
 *   `after-publish` — the set is at its final name and NOTHING has verified it yet.
 *   `before-verify` — the taking step has returned its report and the verification has not started.
 *   `after-verify`  — the verdict exists and the locks have not been released.
 */
export type CompleteBackupFailpoint = 'after-publish' | 'before-verify' | 'after-verify';

export interface ResolvedBackupRequest {
  readonly projectRoot: string;
  readonly destinationDir: string;
  readonly setName: string;
  readonly finalDir: string;
  readonly custodian: CustodianTopology;
  readonly sidecarStateDir: string | null;
  readonly secretsDir: string;
  readonly promotionRecordsDir: string | null;
  readonly quiesce: readonly string[];
}

export function resolveCompleteBackupRequest(request: CompleteBackupRequest): ResolvedBackupRequest {
  const projectRoot = resolveMaintenanceRoot(request.projectRoot, 'project root');
  assertUsableName(request.setName, 'backup set name');

  const destinationDir = resolveInsideRoot(projectRoot, request.destination, 'backup destination');
  if (existsSync(destinationDir)) {
    const stats = lstatSync(destinationDir);
    if (stats.isSymbolicLink()) throw new MaintenanceRefused('the backup destination is a symbolic link');
    if (!stats.isDirectory()) throw new MaintenanceRefused('the backup destination is not a directory');
  }
  const finalDir = join(destinationDir, request.setName);

  // TOPOLOGY: stated, and stated exclusively.
  let sidecarStateDir: string | null = null;
  if (request.custodian === 'sidecar') {
    if (request.sidecarState === undefined || request.sidecarState.trim() === '') {
      throw new MaintenanceRefused(
        'sidecar custody was declared but no sidecar state directory was given. This command will not guess where '
        + 'the keystore is: a backup that copied the wrong directory would look complete and restore into an '
        + 'installation that can decrypt nothing.');
    }
    sidecarStateDir = resolveInsideRoot(projectRoot, request.sidecarState, 'sidecar state directory');
    if (!existsSync(sidecarStateDir) || !statSync(sidecarStateDir).isDirectory()) {
      throw new MaintenanceRefused('the sidecar state directory is not there, so the keystore cannot be taken from it');
    }
    assertPlainTree(sidecarStateDir, 'sidecar state directory');
  } else if (request.sidecarState !== undefined) {
    throw new MaintenanceRefused(
      'a sidecar state directory was given with inline custody. One of the two is wrong, and this command will not '
      + 'choose which.');
  }

  const secretsDir = resolveInsideRoot(projectRoot, request.secrets, 'secrets directory');
  if (!existsSync(secretsDir) || !statSync(secretsDir).isDirectory()) {
    throw new MaintenanceRefused('the secrets directory is not there, so a complete backup cannot be taken');
  }
  assertPlainTree(secretsDir, 'secrets directory');

  let promotionRecordsDir: string | null = null;
  if (request.promotionRecords !== undefined && request.promotionRecords.trim() !== '') {
    promotionRecordsDir = resolveInsideRoot(projectRoot, request.promotionRecords, 'promotion records directory');
    if (existsSync(promotionRecordsDir)) assertPlainTree(promotionRecordsDir, 'promotion records directory');
    else promotionRecordsDir = null;
  }

  return {
    projectRoot,
    destinationDir,
    setName: request.setName,
    finalDir,
    custodian: request.custodian,
    sidecarStateDir,
    secretsDir,
    promotionRecordsDir,
    quiesce: QUIESCED_SERVICES[request.custodian],
  };
}

/**
 * The commands a backup would run, in order, as values.
 *
 * `--plan` prints this and stops. It is also what the acceptance harness asserts against: the argument arrays
 * are the product's, not a description of them.
 */
export function planCompleteBackup(resolved: ResolvedBackupRequest, stagingDir: string): readonly MaintenanceCommand[] {
  const cwd = resolved.projectRoot;
  const commands: MaintenanceCommand[] = [];
  for (const service of resolved.quiesce) {
    commands.push({ program: 'docker', args: ['compose', 'stop', service], cwd, purpose: `stop ${service} so nothing writes` });
  }
  commands.push({
    program: 'docker',
    // `exec -T` on the running postgres container, over its local socket: no password on a command line, and
    // no port published to reach it by. The dump is captured from stdout by the runner, never redirected by a
    // shell — there is no shell.
    args: ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', 'catalog'],
    cwd,
    purpose: 'dump the database while nothing is writing',
  });
  if (resolved.custodian === 'inline') {
    commands.push({
      program: 'docker',
      args: ['compose', 'cp', 'app:/var/lib/catalog/keystore', join(stagingDir, COMPONENT_ARTIFACT_NAMES.keystore)],
      cwd,
      purpose: 'copy the custodian keystore out of the app container',
    });
  }
  for (const service of [...resolved.quiesce].reverse()) {
    commands.push({ program: 'docker', args: ['compose', 'start', service], cwd, purpose: `start ${service} again` });
  }
  return commands;
}

/**
 * A backup that failed, WITH the second fact when there is one.
 *
 * THE DEFECT THIS CLOSES. When a step inside the quiesced window failed AND the restart afterwards also
 * failed, only the first of those two facts reached the operator. The `finally` correctly refused to throw of
 * its own — replacing the failure would have been worse — and recorded the outage as a note; but the note
 * lived on a report that a thrown failure never returns, so it was dropped on the floor. An operator was told
 * "the database dump did not run. Nothing was written." and was NOT told that their installation was down.
 *
 * The primary failure is therefore preserved word for word as `primary`, and the outage is ADDED to it rather
 * than substituted for it. Where the stack did come back, the original error is rethrown untouched: there is
 * nothing to add, and wrapping it would only put this class between an operator and a sentence they can act on.
 */
export class CompleteBackupFailed extends MaintenanceRefused {
  /** The closed sentence of what actually went wrong first. */
  readonly primary: string;
  /** The services this command stopped and could not start again. Never empty on this class. */
  readonly stillStopped: readonly string[];

  constructor(primary: string, stillStopped: readonly string[]) {
    super(`${primary} AND THE STACK IS STILL DOWN: this command stopped ${stillStopped.length} service(s) for the `
      + 'consistent window and could not start them again. START THEM BEFORE ANYTHING ELSE — the backup failure '
      + 'above is the smaller of these two problems.');
    this.name = 'CompleteBackupFailed';
    this.primary = primary;
    this.stillStopped = [...stillStopped];
  }
}

/**
 * Add the outage to a failure, or leave the failure exactly as it is.
 *
 * A FOREIGN ERROR NEVER LENDS ITS MESSAGE. Only this product's own refusals carry wording safe to repeat;
 * anything else becomes a fixed sentence, and the original is not rethrown once there is a second fact to
 * carry, because losing the outage would be the very defect this exists to close.
 */
function withOutage(err: unknown, stillStopped: readonly string[]): unknown {
  if (stillStopped.length === 0) return err;
  const primary = err instanceof MaintenanceRefused
    ? err.message
    : 'the backup could not be taken, for a reason this command does not have safe wording for.';
  return new CompleteBackupFailed(primary, stillStopped);
}

/**
 * Everything between taking the project lock and the first effect: re-resolve, ensure, lock the destination.
 *
 * SEPARATE BECAUSE TWO ENTRY POINTS NEED IT AND NEITHER MAY DRIFT FROM THE OTHER. `runVerifiedCompleteBackup`
 * is the ordinary command and must hold its locks past the verification; `takeCompleteBackupWithoutVerifying`
 * is the unverified taking step a suite drives directly. Both arrive here, in this order, or not at all.
 */
function enterDestination(
  request: CompleteBackupRequest,
  deps: CompleteBackupDeps,
  resolved: ResolvedBackupRequest,
  locks: MaintenanceLocks,
): void {
  // ---- RE-ESTABLISHED UNDER THE PROJECT LOCK, BEFORE THE DESTINATION LOCK IS ASKED FOR -------------
  //
  // Everything resolved before the lock was resolved in a moment that has now passed. A secrets directory
  // that has been replaced by a link, a destination that has become a file, a sidecar state directory that
  // has gone: each of those refuses again here, and each refuses BEFORE this run creates anything at all.
  const underLock = resolveCompleteBackupRequest(request);
  if (underLock.destinationDir !== resolved.destinationDir
    || underLock.finalDir !== resolved.finalDir
    || underLock.secretsDir !== resolved.secretsDir
    || underLock.sidecarStateDir !== resolved.sidecarStateDir
    || underLock.promotionRecordsDir !== resolved.promotionRecordsDir) {
    throw new MaintenanceRefused(
      'the directories this backup resolved changed between resolving them and taking this project\'s lock, '
      + 'so what was checked is not what would have been copied. Nothing was written.');
  }
  ensureDestinationExists(resolved, deps);
  // ---- THE SHARED DESTINATION LOCK, BEFORE THE FIRST STAGING DIRECTORY AND THE FIRST COMMAND -------
  //
  // PHASES 321-328. Until this existed, a second Compose project pointed at the same physical directory
  // could publish a set, prune one, or claim a safety-set directory while this run was building its own
  // — and `ops:backup-retention` counting that destination mid-publication counts a destination that does
  // not exist. It is taken here, which is BEFORE the staging directory is created, BEFORE the first
  // service is stopped and BEFORE `pg_dump` is started: a contender refuses having done nothing at all.
  locks.lockDestination(provePhysicalDestination(resolved.projectRoot, resolved.destinationDir));
}

/**
 * Create the destination if this caller is allowed to, and tolerate losing the race to create it.
 *
 * Creating it is the ONE thing that necessarily happens outside the destination lock, and it is the one
 * thing that cannot hurt: `mkdir` is atomic, so a second project racing this one either loses the race and
 * finds a directory, or wins it and this one does — and both then contend for the lock inside it. A
 * destination that does not exist is a destination nothing else can be half way through.
 */
function ensureDestinationExists(resolved: ResolvedBackupRequest, deps: CompleteBackupDeps): void {
  if (existsSync(resolved.destinationDir)) return;
  if (deps.requireExistingDestination === true) {
    throw new MaintenanceRefused(
      'the destination this backup was told to publish into is not there. The caller requires an existing '
      + 'directory — creating it would produce a directory nothing owns at a path something else has '
      + 'written down. Nothing was taken.');
  }
  try {
    createPrivateDirectory(resolved.destinationDir, 'backup destination');
  } catch (err) {
    // A SECOND CREATOR IS NOT A COLLISION. `createPrivateDirectory` refuses an existing name because most
    // of its callers are claiming one; a backup destination is a directory operators and other projects
    // legitimately share, so an `EEXIST` that is a plain directory means the race was lost, not that
    // something is wrong. Anything else — a file, a link, an unwritable parent — still refuses.
    const beat = lstatSync(resolved.destinationDir, { throwIfNoEntry: false });
    if (beat === undefined || !beat.isDirectory() || beat.isSymbolicLink()) throw err;
  }
}

/**
 * Validate the caller's proof that it is already holding both locks for this backup. CORRECTION 1.
 *
 * BEFORE ANY EFFECT, ALWAYS — before a directory is created, before a claim or journal is touched, before a
 * staging tree exists and before a child command runs. A forged object, a capability for another project, a
 * capability for a sibling or an enclosing destination, and one whose owner has already released are each
 * refused here, and the backup never reaches the filesystem.
 */
function assertNestedAuthority(held: HeldDestination, resolved: ResolvedBackupRequest): void {
  // THE PHYSICAL DESTINATION, NOT THE NAMED ONE. The legitimate caller publishes into a claim directory
  // INSIDE the destination it holds, so the check has to be against the real path of the directory this
  // backup would actually write in. A target that does not exist is passed through as the name it would
  // have had — and is refused there, which is what makes "refused before the destination is created" true.
  const physical = existsSync(resolved.destinationDir)
    ? provePhysicalDestination(resolved.projectRoot, resolved.destinationDir)
    : resolved.destinationDir;
  assertHeldDestination(held, resolved.projectRoot, physical);
}

/**
 * Take a complete backup. INTERNAL — see `runVerifiedCompleteBackup`, which is the only way to a verdict.
 *
 * THE SHAPE OF THE FUNCTION IS THE GUARANTEE. Everything that can refuse happens before the first service is
 * stopped; the stop/take/start window is a `try`/`finally`, so the start runs on every path out; and the set
 * is built in a staging directory beside its final name and published by a rename, so a killed run leaves a
 * staging directory and no set rather than half a set under the name an operator would trust.
 *
 * IT IS EXPORTED UNDER A NAME THAT SAYS WHAT IT IS NOT. A suite drives it directly to exercise the refusals of
 * the taking step, and naming it this way — with no `ok` on what it returns — means no caller can hold its
 * result and believe a backup succeeded. A suite asserts that nothing else under `src/` calls it.
 *
 * IT TAKES ITS OWN LOCKS AND RELEASES THEM WHEN IT RETURNS, which is why the VERIFIED command below does not
 * call it: an unverified set that has been published while the locks are already gone is precisely the window
 * Correction 1 closed. `runVerifiedCompleteBackup` reaches `performBackup` directly, inside its own locks.
 */
export function takeCompleteBackupWithoutVerifying(
  request: CompleteBackupRequest,
  deps: CompleteBackupDeps,
): CompleteBackupReport {
  // ---- EVERYTHING THAT CAN REFUSE WITHOUT CONTENDING FOR ANYTHING, FIRST ----------------------------
  //
  // Re-established under the locks below, and both are needed: this one so a hopeless request — a bad set
  // name, a missing secrets directory, a destination outside the project — refuses without making anything
  // else wait, that one because a check made before a lock is a check about a moment that has passed.
  const resolved = resolveCompleteBackupRequest(request);
  if (deps.held !== undefined) {
    assertNestedAuthority(deps.held, resolved);
    ensureDestinationExists(resolved, deps);
    return performBackup(resolved, deps);
  }
  // NOBODY AUTHORISED A CLAIM, SO A CLAIM IS NOT A DESTINATION. Refused before the project lock, before the
  // destination exists and before anything is created.
  assertNotSafetyClaimNamespace(request.destination);
  const locks = MaintenanceLocks.open(resolved.projectRoot);
  try {
    enterDestination(request, deps, resolved, locks);
    return performBackup(resolved, deps);
  } finally {
    locks.release();
  }
}

/**
 * The taking itself, with BOTH LOCKS ALREADY HELD BY THE CALLER and the destination known to exist.
 *
 * Every path out of here leaves the locks exactly as it found them: this function neither takes nor releases
 * one, so the caller decides how far past the publication the exclusive window extends. That is the whole
 * correction — `runVerifiedCompleteBackup` extends it past the verdict.
 */
function performBackup(
  resolved: ResolvedBackupRequest,
  deps: CompleteBackupDeps,
): CompleteBackupReport {
  const now = deps.now ?? (() => new Date());
  const at = deps.at ?? ((): void => { /* production does nothing here */ });
  const stagingDir = join(resolved.destinationDir, `.${resolved.setName}.staging-${stagingSuffix()}`);
  const notes: string[] = [];
  /**
   * WHAT IS STILL DOWN, tracked outside every inner block on purpose.
   *
   * It is the second fact of a dual failure, and it has to survive the unwinding of the block that produced
   * the first one. `restarted` alone could not do that job: it is `false` before anything has been stopped,
   * so a refusal from before the window would have claimed an outage that never happened.
   */
  const stillStopped: string[] = [];
  let restarted = false;
  let published = false;
  try {
    // ---- THE NAME IS CHECKED UNDER THE LOCK THAT MAKES THE ANSWER STAY TRUE --------------------------
    if (existsSync(resolved.finalDir)) {
      throw new MaintenanceRefused(
        'a backup set of that name is already there. This command will not write into or replace one: choose a new '
        + 'name. Replacing a set is how the only copy of something irrecoverable gets overwritten by a failed run.');
    }

    createPrivateDirectory(stagingDir, 'backup staging directory');

    // ---- the consistent window -----------------------------------------------------------------------
    const quiesced: string[] = [];
    try {
      for (const service of resolved.quiesce) {
        const stop = runGuarded(deps.runner, deps.ledger, {
          program: 'docker', args: ['compose', 'stop', service], cwd: resolved.projectRoot,
          purpose: `stop ${service} so nothing writes`,
        });
        if (stop.status !== 0) {
          throw new MaintenanceRefused(
            `the ${service} service could not be stopped, so the database and the keystore could not be taken from `
            + 'the same moment. Nothing was written.');
        }
        quiesced.push(service);
      }

      // THE DUMP GOES STRAIGHT INTO THE FILE. The child's stdout IS the descriptor; the bytes never enter
      // this process, so there is no encoding to get wrong and no buffer to exceed. See `realFileOutputRunner`.
      const dumpPath = join(stagingDir, COMPONENT_ARTIFACT_NAMES.database);
      const dump = runGuardedToFile(deps.fileRunner, deps.ledger, {
        program: 'docker',
        args: ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', 'catalog'],
        cwd: resolved.projectRoot,
        purpose: 'dump the database while nothing is writing',
      }, dumpPath);
      if (dump.status !== 0) {
        throw new MaintenanceRefused('the database dump did not run. Nothing was written.');
      }
      // ASKED OF THE FILE, NOT OF THE RUNNER. A runner that reported success and wrote nothing is exactly the
      // failure a size check catches and a status check does not.
      const dumped = fileSizeNoFollow(dumpPath);
      if (dumped <= 0) {
        throw new MaintenanceRefused('the database dump produced no bytes. Nothing was written.');
      }

      if (resolved.custodian === 'inline') {
        const copy = runGuarded(deps.runner, deps.ledger, {
          program: 'docker',
          args: ['compose', 'cp', 'app:/var/lib/catalog/keystore', join(stagingDir, COMPONENT_ARTIFACT_NAMES.keystore)],
          cwd: resolved.projectRoot,
          purpose: 'copy the custodian keystore out of the app container',
        });
        if (copy.status !== 0) {
          throw new MaintenanceRefused(
            'the custodian keystore could not be copied out of the app container. Nothing was written — a set '
            + 'without it restores into an installation that can decrypt nothing.');
        }
      } else {
        copyTree(resolved.sidecarStateDir!, join(stagingDir, COMPONENT_ARTIFACT_NAMES.keystore), 'sidecar keystore');
      }

      // ---- STILL INSIDE THE WINDOW: the other two components ----------------------------------------
      //
      // THE DEFECT THIS CLOSES. The first version copied the secrets and the promotion records AFTER the app
      // had been started again. It looked harmless — nothing writes to a read-only records mount, and the
      // setup script does not rewrite secrets — but "nothing writes to it" is a belief about a directory an
      // operator owns, and a four-component set whose components come from two different moments is exactly
      // the inconsistency the whole window exists to prevent. All four now come from one quiesced moment;
      // the cost is a few more seconds of downtime and the benefit is that the claim is true.
      copyTree(resolved.secretsDir, join(stagingDir, COMPONENT_ARTIFACT_NAMES.secrets), 'secrets');
      if (resolved.promotionRecordsDir !== null) {
        copyTree(resolved.promotionRecordsDir, join(stagingDir, COMPONENT_ARTIFACT_NAMES['promotion-records']),
          'promotion records');
      }
    } finally {
      // ALWAYS, on every path out of the window: a refusal, a throw, a failed step, a success.
      //
      // AND IT NEVER THROWS OF ITS OWN. A `finally` that throws REPLACES the error that sent us here, so a
      // failed dump would be reported as a failed restart — losing the one fact an operator needs. Every
      // start is therefore attempted, its failure is recorded, and whatever brought us here is what
      // propagates. Every service that WAS stopped gets an attempt, in reverse order, even if an earlier one
      // could not be started.
      //
      // WHAT IT NO LONGER DOES IS LOSE THE OUTAGE. Recording it only as a note meant it travelled on a report
      // that a thrown failure never returns, so a dual failure told an operator about the dump and not about
      // their stack. `stillStopped` outlives this block, and the catch below carries it into the refusal.
      restarted = true;
      for (const service of [...quiesced].reverse()) {
        try {
          const start = runGuarded(deps.runner, deps.ledger, {
            program: 'docker', args: ['compose', 'start', service], cwd: resolved.projectRoot,
            purpose: `start ${service} again`,
          });
          if (start.status !== 0) throw new MaintenanceRefused('non-zero exit');
        } catch {
          restarted = false;
          stillStopped.push(service);
          notes.push(`The ${service} service did not start again. Start it before anything else: this command has `
            + 'finished and the stack is down.');
        }
      }
    }
    // ---- outside the window: describing what was taken, and publishing it ------------------------------

    // ALL FOUR SLOTS ARE MANIFESTED, present or absent. `BACKUP_COMPONENT_IDS` is the model's own list, so a
    // component that exists in the model and not in this set is a recorded `present: false` rather than a
    // silence somebody later reads as "there were only three".
    const components = BACKUP_COMPONENT_IDS.map((id) => describeComponent(stagingDir, id));
    // WHAT THIS SET NEEDS IS DECIDED BY WHAT IT HOLDS. A keystore with a ring in it must carry the root
    // wrapping key that opens that ring; one without a ring is a static-custody installation, whose secrets
    // are complete without a key that does not exist yet. Read from the STAGED copy — the set as it will be
    // published — rather than from the live installation, so the requirement is a property of the artifact.
    assertRequiredSecretFiles(join(stagingDir, COMPONENT_ARTIFACT_NAMES.secrets),
      { ringPresent: backupSetHasRing(stagingDir) });
    for (const id of REQUIRED_COMPONENT_IDS) {
      const component = components.find((entry) => entry.id === id);
      if (component === undefined || !component.present) {
        throw new MaintenanceRefused(
          `the ${id} component is not in the staged set, so this is not a complete backup. Nothing was published.`);
      }
    }

    const manifest = buildManifest(resolved, components, now());
    writePrivateFile(join(stagingDir, BACKUP_MANIFEST_NAME), manifest.text, 'backup manifest');

    publishDirectory(stagingDir, resolved.finalDir, 'backup set');
    published = true;
    // THE SET IS AT ITS FINAL NAME AND NOTHING HAS VERIFIED IT. Production passes no `at` and this does
    // nothing; a suite stops a real process here to prove both locks are still held at this instant.
    at('after-publish');

    if (!components.some((component) => component.id === 'promotion-records' && component.present)) {
      notes.push('This installation has no promotion record artifacts. That is a correct and permanent state for '
        + 'many installations, and it does not make the set incomplete — the slot is recorded as absent rather '
        + 'than left out.');
    }
    notes.push('Nothing was fetched and no media path was read.');

    return {
      report: COMPLETE_BACKUP_REPORT,
      version: COMPLETE_BACKUP_VERSION,
      published,
      setName: resolved.setName,
      custodian: resolved.custodian,
      components,
      quiesced: resolved.quiesce,
      restarted,
      stillStopped: [...stillStopped],
      schemaVersion: MIGRATION_VERSION,
      manifestDigest: manifest.digest,
      network: 'none',
      mediaAccess: 'none',
      notes,
    };
  } catch (err) {
    // BOTH FACTS, OR THE ONE THAT IS TRUE. This wraps every failure inside the locked region — including the
    // refusals BEFORE the staging directory exists, which is harmless because `stillStopped` is empty until
    // a service has actually been stopped and `withOutage` then returns the error untouched. What it is for
    // is the window and everything after it: a restart that failed while the set was being described leaves
    // exactly the same outage as one that failed while the dump was running.
    throw withOutage(err, stillStopped);
  }
}

/**
 * Take a complete backup AND verify it, as one contract.
 *
 * THE DEFECT THIS CLOSES. The taking function returned a report with `ok: true` on its own, and only the CLI
 * happened to verify afterwards. Any other caller — a future scheduler, a future route, a future phase — got
 * an unverified success that looked exactly like a verified one, and the CLI's extra step was the only thing
 * standing between the two.
 *
 * IT IS CLOSED BY SUBTRACTION, NOT BY DISCIPLINE. `CompleteBackupReport` no longer HAS an `ok` field, and the
 * taking function is named `takeCompleteBackupWithoutVerifying`, so there is no unverified success value in
 * existence for a caller to read. This is the only function in this module that produces an `ok`, and it
 * cannot produce one without a verification report beside it. `ok` here is the conjunction of the set being
 * taken, the stack coming back, and the set verifying.
 */
export interface CompleteBackupOutcome {
  readonly ok: boolean;
  readonly backup: CompleteBackupReport;
  readonly verification: BackupVerificationReport;
  /** Every closed reason this outcome is not `ok`. Empty when it is. */
  readonly failures: readonly string[];
}

/**
 * Take a complete backup and verify it, WITH BOTH LOCKS HELD FROM BEFORE THE FIRST EFFECT UNTIL AFTER THE
 * VERDICT EXISTS.
 *
 * -----------------------------------------------------------------------------------------------------
 * THE DEFECT CORRECTION 1 CLOSES, EXACTLY.
 * -----------------------------------------------------------------------------------------------------
 *
 * This function used to call `takeCompleteBackupWithoutVerifying`, which releases both locks in its own
 * `finally` — and then verify. So the ordinary, documented, operator-facing command dropped the shared
 * destination lock at the instant its set was published and reacquired nothing before reading every byte of
 * that set back. In that window another project could quarantine it, delete it, or rename something else
 * into its name, and this command would then report `ok: true` about a set that no longer exists, report
 * "does not verify" about a set somebody else removed, or verify a directory it did not take. The lock was
 * correct for the whole dangerous part and absent for the part that decides what to tell the operator.
 *
 * SO THE OWNERSHIP MOVED UP. The locks are taken here, the taking step runs under them through publication,
 * the verification runs under them, and only then — after the verdict exists or after a throw — are they
 * released, destination first and project second. `takeCompleteBackupWithoutVerifying` is NOT called: it
 * owns its own locks, and calling it would either self-deadlock or reintroduce the window.
 *
 * THE NESTED CASE IS THE SAME PROPERTY, ONE LEVEL UP. When `ops:complete-restore` hands this a
 * `HeldDestination`, this function takes nothing and releases nothing: the restore's locks cover the whole
 * of the safety set INCLUDING its verification, and they are held until the restore is over.
 */
export function runVerifiedCompleteBackup(
  request: CompleteBackupRequest,
  deps: CompleteBackupDeps,
): CompleteBackupOutcome {
  const resolved = resolveCompleteBackupRequest(request);
  const at = deps.at ?? ((): void => { /* production does nothing here */ });

  if (deps.held !== undefined) {
    // NESTED, UNDER THE CALLER'S LOCKS. Validated before any effect; nothing is taken and nothing released.
    assertNestedAuthority(deps.held, resolved);
    ensureDestinationExists(resolved, deps);
    return verifyWhatWasTaken(performBackup(resolved, deps), resolved, at);
  }
  // NOBODY AUTHORISED A CLAIM, SO A CLAIM IS NOT A DESTINATION. Refused before the project lock, before the
  // destination exists and before anything is created.
  assertNotSafetyClaimNamespace(request.destination);

  const locks = MaintenanceLocks.open(resolved.projectRoot);
  try {
    enterDestination(request, deps, resolved, locks);
    const backup = performBackup(resolved, deps);
    return verifyWhatWasTaken(backup, resolved, at);
  } finally {
    // AFTER THE VERDICT, OR AFTER THE THROW THAT REPLACED IT. Destination then project — the stack's order.
    locks.release();
  }
}

/**
 * Read back what was just published and turn it into the one `ok` this module produces.
 *
 * IT RUNS INSIDE THE CALLER'S LOCKS. Separated only so both entry paths above verify the same way; it takes
 * no lock of its own precisely because the point is that one is already held.
 */
function verifyWhatWasTaken(
  backup: CompleteBackupReport,
  resolved: ResolvedBackupRequest,
  at: (point: CompleteBackupFailpoint) => void,
): CompleteBackupOutcome {
  at('before-verify');
  const verification = verifyBackupSet(join(resolved.destinationDir, resolved.setName));
  at('after-verify');
  const failures: string[] = [];
  if (!backup.restarted) {
    failures.push('the stack did not come back up after the backup, and it is down now');
  }
  if (!verification.ok) failures.push('the set that was taken does not verify');
  return { ok: failures.length === 0, backup, verification, failures };
}

// -----------------------------------------------------------------------------------------------------------
// The manifest
// -----------------------------------------------------------------------------------------------------------

export interface BackupManifest {
  readonly manifest: 'catalog-authority.backup';
  readonly version: typeof BACKUP_MANIFEST_VERSION;
  readonly setName: string;
  readonly takenAt: string;
  readonly schemaVersion: number;
  readonly custodian: CustodianTopology;
  readonly components: readonly BackupComponentResult[];
}

function buildManifest(
  resolved: ResolvedBackupRequest,
  components: readonly BackupComponentResult[],
  takenAt: Date,
): { readonly text: string; readonly digest: string } {
  // STRUCTURAL METADATA AND DIGESTS ONLY. No host path, no secret content, no provider value, and nothing
  // from inside any component — a manifest is the thing most likely to be copied out of a backup and looked
  // at somewhere else.
  const manifest: BackupManifest = {
    manifest: 'catalog-authority.backup',
    version: BACKUP_MANIFEST_VERSION,
    setName: resolved.setName,
    takenAt: takenAt.toISOString(),
    schemaVersion: MIGRATION_VERSION,
    custodian: resolved.custodian,
    components,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  return { text, digest: createHash('sha256').update(text, 'utf8').digest('hex') };
}

export function readBackupManifest(setDir: string): BackupManifest {
  let raw: string;
  try {
    // THE MANIFEST IS OPENED THE SAME WAY EVERY COMPONENT IS. It is the document every other check is
    // compared against, so reading it through a name that could have become a link would undermine all of
    // them at once.
    raw = readFileNoFollow(join(setDir, BACKUP_MANIFEST_NAME), 'backup manifest', 4 * 1024 * 1024)
      .bytes.toString('utf8');
  } catch (err) {
    if (err instanceof MaintenanceRefused && err.message.includes('symbolic link')) throw err;
    throw new MaintenanceRefused('this backup set has no manifest, so what it should contain cannot be established');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MaintenanceRefused('this backup set\'s manifest is not readable JSON');
  }
  const doc = parsed as Partial<BackupManifest>;
  if (doc.manifest !== 'catalog-authority.backup' || doc.version !== BACKUP_MANIFEST_VERSION) {
    throw new MaintenanceRefused('this backup set\'s manifest is not one this build understands');
  }
  if (!Array.isArray(doc.components) || typeof doc.schemaVersion !== 'number' || typeof doc.setName !== 'string') {
    throw new MaintenanceRefused('this backup set\'s manifest is missing the fields a verification needs');
  }
  return doc as BackupManifest;
}

// -----------------------------------------------------------------------------------------------------------
// Copying and describing
// -----------------------------------------------------------------------------------------------------------

/**
 * Copy a directory tree, refusing anything that is not a plain file or directory.
 *
 * `cpSync` is deliberately NOT used with `dereference`: the tree was already proved to contain no symbolic
 * link, and this copies the entries it walked rather than following anything it finds later.
 */
export function copyTree(source: string, destination: string, what: string): void {
  assertPlainTree(source, what);
  createPrivateDirectory(destination, `${what} copy`);
  const walk = (from: string, to: string): void => {
    // THE DIRECTORY ITSELF IS OPENED WITHOUT FOLLOWING A LINK before it is listed, so a directory swapped for
    // a link between the walk deciding to descend and actually descending is refused rather than followed.
    assertDirectoryNoFollow(from, `${what} directory`);
    for (const entry of readdirSync(from).slice().sort()) {
      const child = join(from, entry);
      const target = join(to, entry);
      // `lstat` HERE IS ADVISORY AND ONLY DECIDES WHICH BRANCH TO TRY. What makes the copy safe is that the
      // file branch below opens with `O_NOFOLLOW` and reads THAT descriptor: a leaf swapped to a symbolic
      // link after this `lstat` is refused at the open, not read through. The first version re-opened by
      // path, which is what made the window real.
      const stats = lstatSync(child);
      if (stats.isSymbolicLink()) throw new MaintenanceRefused(`the ${what} gained a symbolic link while it was being copied`);
      if (stats.isDirectory()) { createPrivateDirectory(target, `${what} copy`); walk(child, target); continue; }
      if (!stats.isFile()) throw new MaintenanceRefused(`the ${what} gained a special file while it was being copied`);
      // BYTES, NOT TEXT, AND FROM ONE DESCRIPTOR. A secret file, a wrapped key or an operator's own promotion
      // artifact may hold any byte at all, and a backup that round-tripped it through a string encoding would
      // restore something subtly different from what it copied.
      writePrivateFile(target, readFileNoFollow(child, `${what} entry`).bytes, `${what} copy`);
    }
  };
  walk(source, destination);
}

/** Describe one component of a staged set: present, size, entry count and a digest. Never its content. */
export function describeComponent(setDir: string, id: BackupComponentId): BackupComponentResult {
  const artifact = COMPONENT_ARTIFACT_NAMES[id];
  const path = join(setDir, artifact);
  if (!existsSync(path)) {
    return { id, artifact, present: false, bytes: 0, entries: 0, digest: '' };
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new MaintenanceRefused(`the ${id} component of this set is a symbolic link, which a backup must never be`);
  }
  if (stats.isFile()) {
    // OPENED, `fstat`ED AND DIGESTED AS ONE OBJECT, AND STREAMED. The digest describes the bytes read from the
    // descriptor, not the bytes at a name that could have changed since the `lstat` above — and a database
    // dump larger than any in-memory bound is digested without ever being held.
    const digested = digestFileNoFollow(path, `${id} component`);
    return { id, artifact, present: true, bytes: digested.size, entries: 1, digest: digested.digest };
  }
  const digested = digestTreeAt(path, `${id} component`);
  return { id, artifact, present: true, bytes: digested.bytes, entries: digested.entries, digest: digested.digest };
}

/**
 * Digest a DIRECTORY over its canonical listing plus each file's own digest.
 *
 * Names and digests, in a total order — never the bytes concatenated, which would make the digest depend on
 * the walk order. Every directory is opened without following a link before it is listed, and every leaf is
 * read through one descriptor, so a tree that changed under the walk is refused rather than digested halfway.
 *
 * IT IS EXPORTED FOR ONE REASON, AND IT IS AN ANTI-DRIFT REASON. Phase 301's restore has to answer "does the
 * directory already on disk hold exactly what this set would put there" before it swaps, so that a resumed
 * run does not rename the RESTORED state aside and record it as the previous one. Answering that with a
 * second digest algorithm would make two functions that must agree, and they would not.
 */
export function digestTreeAt(path: string, what: string): {
  readonly digest: string; readonly entries: number; readonly bytes: number;
} {
  const hash = createHash('sha256');
  let entries = 0;
  let bytes = 0;
  const walk = (current: string, prefix: string): void => {
    assertDirectoryNoFollow(current, `${what} directory`);
    for (const entry of readdirSync(current).slice().sort()) {
      const child = join(current, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      const childStats = lstatSync(child);
      if (childStats.isSymbolicLink()) {
        throw new MaintenanceRefused(`the ${what} holds a symbolic link, which a backup must never do`);
      }
      if (childStats.isDirectory()) { hash.update(`d ${relative}\n`); walk(child, relative); continue; }
      if (!childStats.isFile()) {
        throw new MaintenanceRefused(`the ${what} holds a special file, which a backup must never do`);
      }
      // Same discipline as the single-file branch: the digest is of the object that was opened.
      const content = readFileNoFollow(child, `${what} entry`).bytes;
      entries += 1;
      bytes += content.byteLength;
      hash.update(`f ${relative} ${createHash('sha256').update(content).digest('hex')}\n`);
    }
  };
  walk(path, '');
  return { digest: hash.digest('hex'), entries, bytes };
}

/**
 * The secrets copy must hold every file a restore needs.
 *
 * By NAME, never by content: this checks that six files exist, and opens none of them. The list is
 * `backup-components.ts`'s, which a Phase 256 test pins to what the shipped stacks actually declare.
 */
export function assertRequiredSecretFiles(secretsCopy: string, options: { readonly ringPresent: boolean }): void {
  let present: readonly string[];
  try {
    present = readdirSync(secretsCopy);
  } catch {
    throw new MaintenanceRefused('the secrets component could not be listed');
  }
  const required = requiredSecretFilesFor(options.ringPresent);
  const missing = required.filter((name) => !present.includes(name));
  if (missing.length > 0) {
    throw new MaintenanceRefused(
      `the secrets component is missing ${missing.length} of the ${required.length} files a restore `
      + `needs: ${missing.join(', ')}.${options.ringPresent
        ? ' This keystore holds a KEK ring, and a ring without the root wrapping key that seals it restores as'
        + ' a sealed box with no key.'
        : ''} Nothing was published.`);
  }
  // ---- WHERE A ROOT KEY IS REQUIRED, IT MUST BE A ROOT KEY AND NOT MERELY A NAME ----------------------
  //
  // A set holding a RING is sealed under that key: if what is at that name is a placeholder, a truncated
  // write or a note somebody left there, the set restores into an installation that opens nothing, and it
  // would have been called complete on the strength of the name alone.
  //
  // WHERE IT IS NOT REQUIRED, IT IS CARRIED AND NOT JUDGED. A static-custody set has nothing sealed under a
  // root key; whatever is at that path is copied as it is found, and the transition classifier — which is
  // where that file becomes load-bearing — is the thing that refuses a file that is not a key.
  if (options.ringPresent && present.includes(ROOT_KEY_SECRET_NAME)) {
    const path = join(secretsCopy, ROOT_KEY_SECRET_NAME);
    const opened = readFileNoFollow(path, 'root wrapping key in the secrets component', MAX_ROOT_KEY_FILE_BYTES);
    const decoded = decodeKey(opened.bytes.toString('utf8').trim());
    opened.bytes.fill(0);
    if (decoded === null) {
      throw new MaintenanceRefused(
        `the secrets component holds a ${ROOT_KEY_SECRET_NAME} that is not a root wrapping key: it does not `
        + 'hold exactly 32 bytes, hex or base64 encoded. A set is not complete because a file has the right '
        + 'name. Nothing was published.');
    }
    decoded.fill(0);
  }
}

/** The human summary. Base names, counts, digests and closed-set words. */
export function renderCompleteBackup(report: CompleteBackupReport): string {
  const lines: string[] = [];
  // NO VERDICT LINE. This describes what was taken; whether the CYCLE succeeded is the verification's answer
  // and is rendered beside this one. A heading here saying "TAKEN" over an unverified set was the same
  // unearned reassurance the `ok` field was.
  lines.push(`Complete backup — ${report.published ? 'set published' : 'NOT PUBLISHED'}`);
  lines.push(`  set               ${report.setName}`);
  lines.push(`  custody           ${report.custodian}`);
  lines.push(`  schema version    ${report.schemaVersion}`);
  lines.push(`  quiesced          ${report.quiesced.join(', ')}`);
  lines.push(`  restarted         ${report.restarted}`);
  if (report.stillStopped.length > 0) {
    lines.push(`  STILL STOPPED     ${report.stillStopped.join(', ')} — start these before anything else`);
  }
  lines.push(`  manifest digest   ${report.manifestDigest.slice(0, 16)}`);
  lines.push('  components:');
  for (const component of report.components) {
    lines.push(`    ${component.id.padEnd(18)} ${component.present ? 'present' : 'ABSENT '} `
      + `entries=${component.entries} bytes=${component.bytes} ${component.digest.slice(0, 16)}`);
  }
  lines.push(`  network           ${report.network}`);
  lines.push(`  media access      ${report.mediaAccess}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push('  (whether this backup CYCLE succeeded is the verification below, not this section)');
  return lines.join('\n');
}

/** The set's own directory name, for a report that must not carry a path. */
export function setNameOf(setDir: string): string {
  return basename(setDir);
}
