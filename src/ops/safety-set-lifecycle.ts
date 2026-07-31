import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BACKUP_MANIFEST_NAME, readBackupManifest, type BackupManifest } from './complete-backup.js';
import { verifyBackupSet } from './backup-set-verification.js';
import {
  RESTORE_JOURNAL_NAME,
  RESTORE_JOURNAL_VERSION,
  SAFETY_CLAIM_MARKER_NAME,
  SAFETY_CLAIM_NONCE_RE,
  operationSuffix,
  safetySetClaimDirName,
} from './complete-restore.js';
import {
  RETENTION_JOURNAL_NAME,
  inventoryDestination,
  validateInventoryEntry,
} from './backup-retention.js';
import {
  manifestShape,
  proveBackupSetIdentity,
  readRestoreClaimMarker,
  type BackupSetCommitment,
  type ClaimMarkerExpectation,
} from './maintenance-identity.js';
import {
  DESTINATION_LOCK_DIRNAMES,
  MaintenanceLocks,
  SAFETY_CLAIM_DIR_RE,
  MaintenanceRefused,
  assertUsableName,
  createPrivateDirectory,
  readFileNoFollow,
  removeOwnTreeNoFollow,
  resolveBackupDestination,
  resolveMaintenanceRoot,
  stagingSuffix,
  writePrivateFile,
} from './maintenance-safety.js';
import { instantOf, removalEntryBound, type InventoryEntry } from './retention-model.js';
import {
  CLAIM_CLASSES,
  CLAIM_EVIDENCE,
  CLAIM_EVIDENCE_TEXT,
  DEFAULT_SAFETY_SET_POLICY,
  SAFETY_SET_REASON_TEXT,
  MAX_SAFETY_KEEP_LAST,
  MAX_SAFETY_KEEP_MINIMUM,
  MAX_SAFETY_MIN_AGE_DAYS,
  REMOVABLE_CLAIM_CLASSES,
  SAFETY_SET_REASONS,
  assertUsableSafetyPolicy,
  evaluateSafetySetLifecycle,
  type ClaimClass,
  type ClaimEvidence,
  type ClaimInventoryEntry,
  type SafetySetDecision,
  type SafetySetPolicy,
} from './safety-set-model.js';

// Phases 313-320 — the lifecycle of the safety sets a RESTORE creates.
//
// -----------------------------------------------------------------------------------------------------
// THE GAP THIS CLOSES, AND WHY IT COULD NOT BE CLOSED IN THE OTHER COMMAND.
// -----------------------------------------------------------------------------------------------------
//
// Phases 297-304 made every `ops:complete-restore` take a verified backup of the installation it is about to
// destroy, and publish it INSIDE a directory that run claims exclusively:
// `<destination>/.pre-restore-claim-<nonce>/pre-restore-<set>`. Phases 305-312 then shipped
// `ops:backup-retention`, which classifies every dot-prefixed name as `RESERVED` and never descends into one.
// Both are right. Together they mean safety sets accumulate ONE PER RESTORE, FOREVER, and the 305-312 report
// named it as the first remaining review risk.
//
// The fix is NOT to teach retention to descend. That rule is the reason retention cannot damage a backup
// staging tree, a restore in progress, a lock directory or its own quarantine, and it holds for every
// namespace a later phase adds without any of them having to be enumerated. It is not weakened here, and a
// test asserts that it still is not.
//
// So this is a SEPARATE COMMAND with a separate ownership proof. It removes claim DIRECTORIES — the unit the
// restore owns — and only ones whose marker proves `ops:complete-restore` of this build created them.
//
// -----------------------------------------------------------------------------------------------------
// WHAT IT WILL NOT DO.
// -----------------------------------------------------------------------------------------------------
//
//   * IT IS NEVER SCHEDULED. There is no `--yes`, no `--force`, no confirm-by-typing-yes. An operator reads a
//     plan and types back a digest bound to the whole thing. The Unraid example gained a mode that PRINTS a
//     plan and has no mode that removes anything, exactly like the retention mode beside it.
//   * IT NEVER TOUCHES AN ORDINARY BACKUP SET. Top-level sets are inventoried — the floor below is counted
//     over them — and no decision this command makes can name one.
//   * IT REFUSES A PROJECT PART WAY THROUGH A RESTORE, and one part way through a prune.
//   * IT ISSUES NO COMMAND AT ALL: no docker, no child process, no network, no registry, no media path.
//
// WHAT IT READS, EXACTLY. Deciding whether a safety set is good means hashing every byte of it, and one of
// its four components is the secrets directory — so this DOES open and read secret files, through descriptors,
// without following links, for the sole purpose of hashing. It never interprets, parses, prints or reports a
// byte of them, it accepts no credential on a command line, and no path and no component content reaches any
// report. The comfortable claim would be false, so it is not made.
//
// NOTHING IS DELETED IN PLACE. Every claim is RENAMED into a private, marked quarantine directory in the same
// destination (therefore the same filesystem, therefore atomically) and only then removed.
//
// See `docs/PHASES_313_320_SAFETY_SET_LIFECYCLE.md` for the threat model and the limits.

export const SAFETY_SET_REPORT = 'phase-313-320-safety-set-lifecycle';
export const SAFETY_SET_VERSION = 1;

export const SAFETY_SET_JOURNAL_NAME = '.catalog-safety-set.journal.json';

/**
 * Version 2, and anything else is refused AT THE VERSION BOUNDARY before a later field is read.
 *
 * There is no migration and there never will be a silent one: this document decides which directories a
 * recovery is allowed to destroy, and guessing at what a field meant in a schema this build does not
 * implement is how a half-understood record removes the wrong tree.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY IT COULD NOT BE A COMPATIBLE ADDITION.
 * -----------------------------------------------------------------------------------------------------
 *
 * Version 1 recorded `deleting` and nothing else. A resume then proved the OUTER quarantine marker — which
 * says the quarantine directory is this operation's — and recursively removed whatever directory now
 * occupied the planned child name, WITHOUT re-proving the child. The outer marker's allowlist is a list of
 * names, and a name is not a tree: anything moved to that name after the `deleting` record was persisted
 * would have been recursively deleted. The predictable name and the outer allowlist were being used as live
 * child ownership, and neither is.
 *
 * Version 2 adds `consumeNonce` to each entry: an unpredictable value drawn when the entry enters
 * `deleting`, persisted in the journal, and written INTO the tree being consumed as a consumption marker.
 * A version-1 journal cannot carry one, so a `deleting` entry in it can never be proved against a live
 * child — there is nothing correct to fill the field in with, and the document is refused for BEING one.
 */
export const SAFETY_SET_JOURNAL_VERSION = 2;

/** The journal is bounded before it is parsed. A destination of 2000 entries fits inside this many times over. */
export const MAX_SAFETY_JOURNAL_BYTES = 4 * 1024 * 1024;

/** The private directory claims are renamed into before they are removed. */
export const SAFETY_QUARANTINE_PREFIX = '.catalog-safety-set.removing-';

/** The unpredictable, secret-free name a quarantine directory is BUILT under before it is published. */
export const SAFETY_QUARANTINE_CLAIM_PREFIX = '.catalog-safety-set.claiming-';

/** The ownership marker inside a quarantine directory. Nothing is removed from a tree without one. */
export const SAFETY_QUARANTINE_MARKER_NAME = 'catalog-safety-set-quarantine.json';

/**
 * The consumption marker written INSIDE the claim tree that is about to be destroyed.
 *
 * -----------------------------------------------------------------------------------------------------
 * THE OUTER MARKER PROVES THE CONTAINER. THIS PROVES THE CHILD.
 * -----------------------------------------------------------------------------------------------------
 *
 * A quarantine marker says "this DIRECTORY is this operation's" and carries the list of names this
 * operation put in it. That is a list of NAMES, and a name is not a tree. Once an entry is recorded
 * `deleting` the tree it names may be partial, so it cannot be re-proved against its commitment — and the
 * first cut concluded from that that it could be removed on the strength of the outer marker alone.
 * Anything that took the child's name after the record was persisted was then recursively deleted.
 *
 * So the authority for consuming a child lives INSIDE the child, is bound to an unpredictable value drawn
 * per consumption and persisted in the journal, and — this is the part that makes it work at all — it is
 * the LAST thing removed. That gives one invariant, and every question a recovery asks is answered by it:
 *
 *   THE FIRST `unlink` INSIDE A CLAIM IS ALWAYS PRECEDED BY A VALID CONSUMPTION MARKER INSIDE IT.
 *
 *   * marker ABSENT   — nothing has been unlinked, so the tree must still prove to be the planned claim,
 *                       exactly as an intact one does. A stranger's tree fails that and is refused.
 *   * marker PRESENT and ours — this operation began consuming this tree. It may be partial, and finishing
 *                       it is authorised whatever state it is in.
 *   * marker PRESENT and not ours — refused. Nothing is removed and nothing after it is touched.
 *
 * What it is NOT: proof against somebody who can rewrite the journal, because the value it binds is written
 * down there. That is the same boundary every other proof in this command has, it is stated in the threat
 * model, and it is not restated as a stronger claim here.
 */
export const SAFETY_CONSUMING_MARKER_NAME = 'catalog-safety-set-consuming.json';

/** The shape of a consumption nonce. Validated wherever one is read back out of a durable document. */
export const CONSUME_NONCE_RE = /^[0-9a-f]{24}$/;

/** Exactly what `stagingSuffix()` produces. Validated wherever a suffix is concatenated into a path. */
export const SAFETY_SUFFIX_RE = /^[0-9a-f]{12}$/;

/**
 * The name shape a restore claim directory has.
 *
 * IT IS USED TO DECIDE WHAT TO LOOK AT, NEVER TO DECIDE WHAT IS OURS. A directory with this shape and no
 * valid marker is reported as `MALFORMED` and protected; a directory with a valid marker under any other name
 * is reported as `MALFORMED` too, with `MARKER_NAME_DISAGREES`, because a claim somebody moved is a claim
 * whose relationship to the run that made it nobody here can reconstruct.
 */
// ONE DEFINITION, on the shared floor — Correction 1. `ops:complete-backup` refuses a destination inside
// this namespace and the held-destination capability authorises exactly one directory of this shape, so the
// pattern cannot live in this file alone any more.
export const CLAIM_NAME_RE = SAFETY_CLAIM_DIR_RE;

/** What `readRestoreClaimMarker` needs to know about the build whose claims this is reading. */
export const CLAIM_MARKER_EXPECTATION: ClaimMarkerExpectation = Object.freeze({
  journalVersion: RESTORE_JOURNAL_VERSION,
  nonceRe: SAFETY_CLAIM_NONCE_RE,
  claimDirName: safetySetClaimDirName,
  suffixOf: operationSuffix,
});

export function safetyQuarantineDirName(suffix: string): string {
  if (!SAFETY_SUFFIX_RE.test(suffix)) {
    throw new MaintenanceRefused('the safety-set lifecycle run suffix is not one this command produces');
  }
  return `${SAFETY_QUARANTINE_PREFIX}${suffix}`;
}

// -----------------------------------------------------------------------------------------------------------
// The request, and what resolving it proves
// -----------------------------------------------------------------------------------------------------------

export interface SafetySetRequest {
  /** The Compose project directory, absolute. */
  readonly projectRoot: string;
  /** Where sets are kept, relative to the project. */
  readonly destination: string;
}

export interface ResolvedSafetySet {
  readonly projectRoot: string;
  readonly destinationDir: string;
  /** Exactly what the operator wrote, relative to the project. This is what the journal records. */
  readonly destinationRelative: string;
  /** The destination's own leaf name. The only part of it that ever reaches a report. */
  readonly destinationName: string;
}

/**
 * Resolve a request, refusing everything a run would refuse before anything is read.
 *
 * -----------------------------------------------------------------------------------------------------
 * TWO OTHER COMMANDS CAN BE PART WAY THROUGH THE SAME DESTINATION, AND BOTH REFUSE THIS ONE.
 * -----------------------------------------------------------------------------------------------------
 *
 * A RESTORE IN PROGRESS. Its journal names the safety-set claim it created and, on some paths, has not yet
 * published into. That claim is the only record of the installation this restore is destroying, and this
 * command does not attempt to reason about which claim in the destination it is: it stops before the
 * destination is even listed. The check is `existsSync` rather than a parse, so a restore journal this build
 * cannot read still refuses. This is the mechanism by which "anything referenced by a live restore journal is
 * protected" is implemented — refusing the whole operation is strictly stronger than classifying one entry.
 *
 * A PRUNE IN PROGRESS. `ops:backup-retention` leaves its own journal and a quarantine directory holding whole
 * backup sets that are not, for the moment, at their names. This command counts restorable sets across the
 * WHOLE destination to decide whether a safety set may go, and a count taken while some of them are set aside
 * mid-prune is a count of a destination that does not exist. So it refuses too, and says which command to
 * finish.
 *
 * NEITHER REFUSAL IS RECIPROCAL, deliberately. `ops:backup-retention` is NOT taught to refuse when this
 * command's journal is present: two commands that each refuse while the other is interrupted is a pair
 * neither of which can ever be resumed. Retention never descends into a claim namespace, so an interrupted
 * lifecycle run cannot make a prune wrong — while the reverse is not true, which is why the refusal points
 * this way and only this way. See `proveFloorFromDisk` for what closes the remaining window.
 */
export function resolveSafetySetRequest(request: SafetySetRequest): ResolvedSafetySet {
  const projectRoot = resolveSafetySetProject(request.projectRoot);
  return resolveSafetySetDestination(projectRoot, request.destination);
}

export function resolveSafetySetProject(projectRoot: string): string {
  const root = resolveMaintenanceRoot(projectRoot, 'project directory');
  assertNoOtherOperationInProgress(root);
  return root;
}

/**
 * Is there ANYTHING at this name in the project root?
 *
 * -----------------------------------------------------------------------------------------------------
 * PRESENCE, NOT READABILITY, AND ASKED WITHOUT FOLLOWING A LINK.
 * -----------------------------------------------------------------------------------------------------
 *
 * THE DEFECT THIS CLOSES. `existsSync` FOLLOWS a symbolic link, so it answers false for a DANGLING one — and
 * a dangling link at a journal's name is exactly the state a half-tidied project is in. It answers false for
 * a link into a directory that has gone, and it answers about the TARGET rather than about the name for
 * every link that resolves. The question this command needs answered is "has another command left its mark
 * here", and the safe answer to "there is something at that name and this build cannot say what" is YES.
 *
 * `lstat` answers about the name itself, and anything at all — a file, a directory, a link, a dangling link,
 * a device — is a reason to stop. A journal this build cannot read is still a journal.
 */
export function operationMarkPresent(projectRoot: string, name: string): boolean {
  return lstatSync(join(projectRoot, name), { throwIfNoEntry: false }) !== undefined;
}

/**
 * Refuse while a RESTORE is part way through this project. Fail-closed, and taken on every path.
 *
 * IT IS SEPARATE FROM THE PRUNE REFUSAL BECAUSE `--abandon` TAKES THIS ONE AND NOT THAT ONE. An abandon is a
 * recovery: refusing it while an interrupted prune exists would be half of a pair of commands that can each
 * only be unwound after the other, which is a wedge with no way out. A live RESTORE is different in kind —
 * it holds a claim on somewhere to publish the only record of the installation it is destroying, and an
 * abandon renames claim directories back into the same destination under names a restore may be about to
 * use. So the restore refusal has no exception, and it is checked before a single byte is written.
 */
export function assertNoRestoreInProgress(projectRoot: string): void {
  if (operationMarkPresent(projectRoot, RESTORE_JOURNAL_NAME)) {
    throw new MaintenanceRefused(
      'this project is part way through a restore — ops:complete-restore left its journal here. That run holds '
      + 'a claim on somewhere to publish its safety set, and the safety set it takes is the only record of the '
      + 'installation it is destroying, so nothing here will move or remove anything. Finish it with --resume '
      + 'or unwind it with --abandon first.');
  }
}

export function assertNoOtherOperationInProgress(projectRoot: string): void {
  assertNoRestoreInProgress(projectRoot);
  if (operationMarkPresent(projectRoot, RETENTION_JOURNAL_NAME)) {
    throw new MaintenanceRefused(
      'this project is part way through a backup prune — ops:backup-retention left its journal here. Some of '
      + 'this destination\'s ordinary sets are renamed aside into its quarantine directory, and this command '
      + 'decides what it may remove by counting the sets this build could restore FROM ACROSS THE WHOLE '
      + 'DESTINATION. That count is not a count of any destination while a prune is half done. Finish it with '
      + 'ops:backup-retention --resume, or unwind it with --abandon, and run this again afterwards.');
  }
}

/**
 * Resolve a destination named RELATIVE to the project.
 *
 * IT IS RELATIVE, AND THAT IS WHY THE JOURNAL CAN RECORD IT. A durable file in an operator's project
 * directory has no business carrying that operator's absolute appdata layout; the journal lives IN the
 * project root, so the project root is the one path a reader always already has.
 */
export function resolveSafetySetDestination(projectRoot: string, relative: string): ResolvedSafetySet {
  // ONE RESOLUTION, SHARED WITH THE OTHER THREE COMMANDS — Phases 321-328. It is the same function
  // `ops:backup-retention`, `ops:complete-backup` and `ops:complete-restore` resolve through, so all four
  // agree on which physical directory a relative destination names, which is the precondition for the lock
  // taken in it to exclude anything at all.
  return resolveBackupDestination(projectRoot, relative);
}

// -----------------------------------------------------------------------------------------------------------
// Phase 313 — the claim inventory
// -----------------------------------------------------------------------------------------------------------

/** How many claim directories this command will inventory. More than this is not a destination of ours. */
export const MAX_CLAIM_ENTRIES = 2000;

/**
 * Every top-level entry that IS a claim, or is shaped like one, classified from evidence.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHAT IS LOOKED AT, AND WHY IT IS NOT "EVERY DOT NAME".
 * -----------------------------------------------------------------------------------------------------
 *
 * An entry enters this inventory when EITHER of two things is true:
 *
 *   1. it carries a file at the claim marker's name — whatever that file turns out to be. This is the
 *      evidence-first half: a claim somebody RENAMED is still found, and is reported as MOVED rather than
 *      silently ignored. A directory this command never looks at is a directory whose state nobody sees.
 *   2. its own name has the shape a claim directory's name has. This is the shape half, and it exists so a
 *      claim-shaped directory carrying NO marker is reported as `MALFORMED` rather than invisible.
 *
 * Neither is trusted alone: the class is decided by the marker, and a marker whose nonce does not name the
 * directory it is sitting in proves nothing about that directory.
 *
 * IT NEVER FOLLOWS A LINK. `lstat` at every step; a reparse point at a claim-shaped name is `NOT_A_DIRECTORY`
 * and is never opened, listed or removed.
 *
 * IT DESCENDS EXACTLY ONE LEVEL, INTO A DIRECTORY THAT HAS ALREADY PROVED IT IS OURS. The marker is read
 * first; only then is the claim listed, and only then is the one thing inside it verified as a backup set.
 */
export function inventoryClaims(destinationDir: string): readonly ClaimInventoryEntry[] {
  let names: readonly string[];
  try {
    names = readdirSync(destinationDir).slice().sort();
  } catch {
    throw new MaintenanceRefused('the backup destination could not be listed');
  }
  if (names.length > MAX_CLAIM_ENTRIES) {
    throw new MaintenanceRefused(
      `this backup destination holds more than ${MAX_CLAIM_ENTRIES} entries, which is more than this command `
      + 'will inventory. Point it at a destination this product manages.');
  }
  const out: ClaimInventoryEntry[] = [];
  for (const name of names) {
    if (DESTINATION_LOCK_DIRNAMES.includes(name)) continue;
    // THIS COMMAND'S OWN IN-FLIGHT ARTIFACTS ARE NOT CLAIMS. A quarantine directory it published holds claims
    // and is not one, and counting it would make the plan and the re-plan under the lock disagree.
    if (name.startsWith(SAFETY_QUARANTINE_PREFIX) || name.startsWith(SAFETY_QUARANTINE_CLAIM_PREFIX)) continue;
    const claimDir = join(destinationDir, name);
    const shaped = CLAIM_NAME_RE.test(name);
    // ---- THE TOP-LEVEL ENTRY IS EXAMINED BEFORE ANY CHILD OF IT IS NAMED --------------------------
    //
    // THE DEFECT THIS CLOSES. This used to `lstat` `<entry>/catalog-restore-claim.json` first, to decide
    // whether the entry carried a marker. That path resolves `<entry>` — so for a symbolic link or a Windows
    // junction the probe TRAVERSED THE LINK, out of the destination and into whatever it pointed at, purely
    // to answer a question about admission. A directory this command has been told to inventory must never
    // be a reason to read somewhere it was not told to look.
    //
    // So the entry itself is `lstat`ed first, and a child of it is named only once it is known to be a real
    // directory. A link at a claim-SHAPED name is still admitted — by its name alone, and classified
    // `NOT_A_DIRECTORY` without being opened — because an operator has to see it. A link at any other name
    // is not this command's business at all, and is not touched, opened or followed to find out.
    const stats = lstatSync(claimDir, { throwIfNoEntry: false });
    const examinable = stats !== undefined && !stats.isSymbolicLink() && stats.isDirectory();
    const carriesMarker = examinable
      && lstatSync(join(claimDir, SAFETY_CLAIM_MARKER_NAME), { throwIfNoEntry: false }) !== undefined;
    if (!shaped && !carriesMarker) continue;
    out.push(classifyClaim(destinationDir, name));
  }
  return out;
}

export function classifyClaim(destinationDir: string, name: string): ClaimInventoryEntry {
  const claimDir = join(destinationDir, name);
  const empty = {
    name, nonce: null, claimDigest: '', setName: null, setDigest: '', takenAt: null, takenAtMs: null,
    schemaVersion: null, restorable: false, bytes: 0, entries: 0, findings: [] as readonly string[],
    observedAtMs: null,
  };

  let stats;
  try {
    stats = lstatSync(claimDir);
  } catch {
    return { ...empty, claimClass: 'UNREADABLE', evidence: 'UNLISTABLE' };
  }
  // `lstat`, SO A SYMBOLIC LINK OR A WINDOWS REPARSE POINT IS SEEN AS ONE. A claim is never a link, and a link
  // at a claim's name points at bytes this command did not create and will not remove through.
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return { ...empty, claimClass: 'NOT_A_DIRECTORY', evidence: 'NOT_A_DIRECTORY' };
  }

  // ---- THE MARKER, BEFORE THE DIRECTORY IS LISTED ---------------------------------------------------
  const reading = readRestoreClaimMarker(claimDir, name, CLAIM_MARKER_EXPECTATION);
  if (!reading.ok) {
    const evidence = reading.why satisfies ClaimEvidence;
    return {
      ...empty,
      claimClass: reading.why === 'MARKER_OTHER_SCHEMA' ? 'OTHER_BUILD' : 'MALFORMED',
      evidence,
    };
  }
  const proved = {
    ...empty,
    nonce: reading.identity.nonce,
    claimDigest: reading.identity.planDigest,
    observedAtMs: modifiedAtMs(claimDir),
  };

  let members: readonly string[];
  try {
    members = readdirSync(claimDir).slice().sort().filter((entry) => entry !== SAFETY_CLAIM_MARKER_NAME);
  } catch {
    return { ...proved, claimClass: 'UNREADABLE', evidence: 'UNLISTABLE' };
  }
  if (members.length === 0) return { ...proved, claimClass: 'OWNED_EMPTY', evidence: 'EMPTY' };
  // AN IN-FLIGHT ARTIFACT MEANS SOMETHING IS, OR WAS, STILL WRITING. `ops:complete-backup` builds a set in
  // `.<set>.staging-<hex>` beside its final name and publishes it by a rename, so a dot-prefixed member is
  // either a backup being taken into this claim right now or one that was killed part way.
  if (members.some((member) => member.startsWith('.'))) {
    return { ...proved, claimClass: 'OWNED_IN_FLIGHT', evidence: 'IN_FLIGHT_ARTIFACT' };
  }
  if (members.length > 1) return { ...proved, claimClass: 'OWNED_UNEXPECTED', evidence: 'UNEXPECTED_MEMBERS' };

  const setName = members[0]!;
  const setDir = join(claimDir, setName);
  let setStats;
  try {
    setStats = lstatSync(setDir);
  } catch {
    return { ...proved, claimClass: 'OWNED_UNEXPECTED', evidence: 'UNEXPECTED_MEMBERS' };
  }
  if (setStats.isSymbolicLink() || !setStats.isDirectory() || !existsSync(join(setDir, BACKUP_MANIFEST_NAME))) {
    // A LINK, A FILE OR A DIRECTORY WITH NO MANIFEST INSIDE A PROVED CLAIM. The claim is ours and what is in
    // it is not a backup set of ours, so this command cannot say what removing it would destroy.
    return { ...proved, claimClass: 'OWNED_UNEXPECTED', evidence: 'UNEXPECTED_MEMBERS', setName };
  }

  let manifest: BackupManifest;
  try {
    manifest = readBackupManifest(setDir);
  } catch {
    return { ...proved, claimClass: 'OWNED_UNVERIFIED', evidence: 'SET_UNREADABLE', setName };
  }
  const shape = manifestShape(setName, manifest);
  let report;
  try {
    report = verifyBackupSet(setDir);
  } catch {
    // A SET THAT CANNOT BE EXAMINED IS NOT A SET THAT CAN BE REMOVED. Whatever stopped the verification is a
    // question, and this command does not answer a question by deleting the thing that asked it. It stays
    // `OWNED_UNVERIFIED` with no digest, which `proveBackupSetIdentity` refuses to act on in any case.
    return { ...proved, ...shape, name, claimClass: 'OWNED_UNVERIFIED', evidence: 'SET_UNREADABLE', setName };
  }
  const findings = [...new Set(report.problems.map((problem) => problem.finding))].sort();
  return {
    ...proved,
    ...shape,
    name,
    setName,
    claimClass: report.ok ? 'OWNED_SET' : 'OWNED_UNVERIFIED',
    evidence: report.ok ? 'MARKER_PROVED' : 'SET_DOES_NOT_VERIFY',
    setDigest: report.setDigest,
    // `restorable` MEANS "COMPLETE, AND THIS BUILD COULD PUT IT BACK", AND BOTH HALVES ARE LOAD-BEARING.
    //
    // `restorableUnderThisBuild` is about the SCHEMA VERSION alone, so a set with a truncated component is
    // still "restorable" by that measure — and this field is what the floor counts and what the unconditional
    // protection is chosen by. A destination whose floor was met by a set that does not verify would be a
    // destination this command believed it could still recover, wrongly. It is also the invariant
    // `validateClaimEntry` enforces on a persisted row: only `OWNED_SET` may claim it.
    restorable: report.ok && report.restorableUnderThisBuild,
    findings,
  };
}

/** A directory's modification time in epoch milliseconds, or null when it cannot be read. Weak evidence. */
function modifiedAtMs(path: string): number | null {
  try {
    const value = statSync(path).mtimeMs;
    return Number.isFinite(value) ? Math.trunc(value) : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------------------------------------
// Phase 315 — the plan, and the digest that binds the list somebody read
// -----------------------------------------------------------------------------------------------------------

export interface SafetySetPlan {
  readonly report: typeof SAFETY_SET_REPORT;
  readonly version: typeof SAFETY_SET_VERSION;
  readonly journalVersion: typeof SAFETY_SET_JOURNAL_VERSION;
  readonly destinationName: string;
  readonly policy: SafetySetPolicy;
  /**
   * The instant these decisions were evaluated at.
   *
   * IT IS IN THE PLAN AND IN THE JOURNAL, AND DELIBERATELY NOT IN THE DIGEST. The journal needs it so that a
   * recovery can RE-RUN the evaluation rather than re-hash it. The digest must not carry it, because a digest
   * that moved every millisecond could never be typed back.
   */
  readonly evaluatedAt: string;
  readonly claims: readonly ClaimInventoryEntry[];
  /** The destination's ordinary top-level inventory. Bound into the digest, and counted for the floor. */
  readonly destination: readonly InventoryEntry[];
  readonly decisions: readonly SafetySetDecision[];
  /** Ordered OLDEST FIRST. This is the order the run performs, and the order a resume continues. */
  readonly removals: readonly string[];
  readonly protectedNewestRestorable: string | null;
  readonly protectedNewestRollbackPoint: string | null;
  readonly restorableRemaining: number;
  readonly restorableTopLevel: number;
  readonly bytesToRemove: number;
  readonly digest: string;
  readonly wrote: 'nothing';
  readonly network: 'none';
  readonly commands: 'none';
}

/**
 * The canonical identity of one safety-set lifecycle operation.
 *
 * IT BINDS EVERYTHING A DECISION RESTED ON, and that is the whole point of typing a digest back:
 *
 *   * the project and the destination — hashed, never rendered, so two projects holding identically named
 *     claims cannot share a digest;
 *   * every claim's MARKER IDENTITY — its nonce and the plan digest of the restore that created it — so a
 *     claim replaced by another valid claim of ours between the plan and the confirmation refuses;
 *   * every claim's class, evidence, safety-set identity, date, sizes and findings;
 *   * the destination's ORDINARY inventory, so a nightly backup taken since the plan was read refuses — the
 *     floor was counted over those sets, and a floor counted over a different list is a different decision;
 *   * the policy, the ordered removals, both protected claims and the remaining count.
 */
export function canonicalSafetySetOperation(
  resolved: ResolvedSafetySet,
  policy: SafetySetPolicy,
  claims: readonly ClaimInventoryEntry[],
  destination: readonly InventoryEntry[],
  decisions: readonly SafetySetDecision[],
  removals: readonly string[],
  protectedNewestRestorable: string | null,
  protectedNewestRollbackPoint: string | null,
  restorableRemaining: number,
  restorableTopLevel: number,
): string {
  return JSON.stringify([
    SAFETY_SET_REPORT,
    SAFETY_SET_VERSION,
    SAFETY_SET_JOURNAL_VERSION,
    resolved.projectRoot,
    resolved.destinationDir,
    [policy.keepLast, policy.minAgeDays, policy.includeUnverified, policy.includeEmptyClaims,
      policy.keepMinimumRestorable],
    claims.map((claim) => [
      claim.name, claim.claimClass, claim.evidence, claim.nonce, claim.claimDigest, claim.setName,
      claim.setDigest, claim.takenAt, claim.takenAtMs, claim.schemaVersion, claim.restorable, claim.bytes,
      claim.entries, [...claim.findings], claim.observedAtMs,
    ]),
    destination.map((entry) => [
      entry.name, entry.setClass, entry.takenAt, entry.takenAtMs, entry.schemaVersion, entry.setDigest,
      entry.restorable, entry.bytes, entry.entries, [...entry.findings],
    ]),
    decisions.map((decision) => [decision.name, decision.decision, decision.reason]),
    [...removals],
    protectedNewestRestorable,
    protectedNewestRollbackPoint,
    restorableRemaining,
    restorableTopLevel,
  ]);
}

export function digestSafetySetOperation(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Inventory, verify, evaluate and produce the plan. Takes no lock, creates nothing, removes nothing.
 *
 * A REFUSED EVALUATION HAS NO DIGEST. Both refusals throw rather than rendering, because a plan that printed
 * a confirmable digest beside "this would leave you with nothing to restore from" would be a plan somebody
 * could confirm.
 *
 * IT READS EVERY BYTE OF EVERY SET IN THE DESTINATION, TWICE OVER A WHOLE RUN — once here and once under the
 * lock. That is real time on a large destination, and it is why this is a human operation and not a job.
 */
export function planSafetySetLifecycle(
  resolved: ResolvedSafetySet,
  policy: SafetySetPolicy,
  now: Date,
): SafetySetPlan {
  assertUsableSafetyPolicy(policy);
  const claims = inventoryClaims(resolved.destinationDir);
  const destination = inventoryDestination(resolved.destinationDir);
  const evaluation = evaluateSafetySetLifecycle(claims, destination, policy, now);
  for (const refusal of evaluation.refusals) {
    if (refusal === 'NO_RESTORABLE_SET') {
      throw new MaintenanceRefused(
        'this backup destination holds no verified set that this build could restore — not at the top level '
        + 'and not inside any restore claim — so nothing here will be removed. A lifecycle decision is one '
        + 'made while holding a good backup; on a day when there is not one, the thing to do is take one — '
        + 'npm run ops:complete-backup.');
    }
    throw new MaintenanceRefused(
      `this policy would leave ${evaluation.restorableRemaining} restorable set(s) across this destination and `
      + `--keep-minimum-restorable is ${policy.keepMinimumRestorable}. Nothing was removed. Raise --keep-last, `
      + 'or take a backup first.');
  }
  const byName = new Map(claims.map((claim) => [claim.name, claim]));
  const bytesToRemove = evaluation.removals.reduce((total, name) => total + (byName.get(name)?.bytes ?? 0), 0);
  return {
    report: SAFETY_SET_REPORT,
    version: SAFETY_SET_VERSION,
    journalVersion: SAFETY_SET_JOURNAL_VERSION,
    destinationName: resolved.destinationName,
    policy,
    evaluatedAt: new Date(now.getTime()).toISOString(),
    claims,
    destination,
    decisions: evaluation.decisions,
    removals: evaluation.removals,
    protectedNewestRestorable: evaluation.protectedNewestRestorable,
    protectedNewestRollbackPoint: evaluation.protectedNewestRollbackPoint,
    restorableRemaining: evaluation.restorableRemaining,
    restorableTopLevel: evaluation.restorableTopLevel,
    bytesToRemove,
    digest: digestSafetySetOperation(canonicalSafetySetOperation(resolved, policy, claims, destination,
      evaluation.decisions, evaluation.removals, evaluation.protectedNewestRestorable,
      evaluation.protectedNewestRollbackPoint, evaluation.restorableRemaining, evaluation.restorableTopLevel)),
    wrote: 'nothing',
    network: 'none',
    commands: 'none',
  };
}

// -----------------------------------------------------------------------------------------------------------
// Phase 316 — the journal
// -----------------------------------------------------------------------------------------------------------

/**
 * The per-claim states.
 *
 * `deleting` IS WHY THIS IS FIVE STATES AND NOT FOUR. A process that stops existing inside a recursive
 * removal leaves a HALF-CONSUMED tree; `quarantined` beside an intact tree and `quarantined` beside a
 * half-consumed one are indistinguishable, and a resume has to (a) re-prove an intact tree against its
 * commitment before destroying it and (b) finish a legitimately partial one. It cannot do both without
 * knowing which it is looking at. `deleting` is written BEFORE the first `unlink` and is the only state under
 * which a tree that does not match its commitment may still be removed.
 */
export type SafetyEntryState = 'pending' | 'quarantined' | 'deleting' | 'removed' | 'failed';

export const SAFETY_ENTRY_STATES: readonly SafetyEntryState[] =
  Object.freeze(['pending', 'quarantined', 'deleting', 'removed', 'failed']);

export interface SafetyJournalEntry {
  readonly name: string;
  readonly state: SafetyEntryState;
  /** A closed sentence, only ever present on `failed`. */
  readonly reason: string | null;
  /**
   * The unpredictable value this consumption is bound to. Present EXACTLY when the state is `deleting`.
   *
   * It is drawn from the system CSPRNG when the entry enters `deleting`, persisted here, and written into
   * the tree being consumed. A `deleting` entry without one describes a consumption whose live child can
   * never be identified, which is why version 1 of this document is refused rather than upgraded.
   */
  readonly consumeNonce: string | null;
}

export type SafetyPhase = 'removing' | 'abandoning';

export interface SafetySetJournal {
  readonly journal: 'catalog-authority.safety-set-lifecycle';
  readonly version: typeof SAFETY_SET_JOURNAL_VERSION;
  readonly planDigest: string;
  /** The destination, RELATIVE to the project the journal is in — never an absolute path. */
  readonly destination: string;
  readonly suffix: string;
  readonly policy: SafetySetPolicy;
  /** The instant the decisions were evaluated at. Re-evaluated from, never merely re-hashed. */
  readonly evaluatedAt: string;
  readonly claims: readonly ClaimInventoryEntry[];
  readonly destinationSets: readonly InventoryEntry[];
  readonly decisions: readonly SafetySetDecision[];
  readonly removals: readonly string[];
  readonly protectedNewestRestorable: string | null;
  readonly protectedNewestRollbackPoint: string | null;
  readonly restorableRemaining: number;
  readonly restorableTopLevel: number;
  readonly entries: readonly SafetyJournalEntry[];
  readonly phase: SafetyPhase;
}

export function safetySetJournalPath(projectRoot: string): string {
  return join(projectRoot, SAFETY_SET_JOURNAL_NAME);
}

class JournalRefusal extends Error {}

/**
 * Read the journal, and prove it describes an operation this program would perform.
 *
 * -----------------------------------------------------------------------------------------------------
 * RE-HASHING A DOCUMENT IS NOT AUTHORITY OVER IT.
 * -----------------------------------------------------------------------------------------------------
 *
 * This is the lesson `ops:backup-retention` learned the hard way and it is built in here from the start.
 * Recomputing the plan digest over the journal's OWN recorded inventory proves a document agrees with
 * itself — nothing more. Somebody who understands the format can change a protected claim's decision to
 * `remove`, append it to the removal list, RECOMPUTE the digest over the edited content, and be obeyed.
 *
 * The authority is the EVALUATOR, in four layers:
 *
 *   1. Every claim row, every destination row and every decision row is validated MEMBER BY MEMBER before
 *      anything maps, filters or casts over it — so a `null`, a scalar, a missing field or an unknown class
 *      is a closed refusal rather than a `TypeError` out of a `.map` somewhere later.
 *   2. The evaluation instant is recorded, so `evaluateSafetySetLifecycle(claims, destination, policy,
 *      evaluatedAt)` is RUN AGAIN. Its decisions, ordered removals, both protected claims and both counts
 *      must equal the journal's exactly. A forged decision therefore has to be one the evaluator itself
 *      produces — and the unconditional protections are properties of a row's CLASS, which no instant and no
 *      policy can talk past.
 *   3. Every removal must name a claim row whose class the policy admitted. A forgery pointing the operation
 *      at a `MALFORMED`, `OTHER_BUILD`, `OWNED_IN_FLIGHT` or `OWNED_UNEXPECTED` row dies here, before the
 *      evaluator is even asked.
 *   4. And the one forgery a document can still be self-consistent about — a fabricated row claiming a
 *      stranger's directory is a proved claim of ours — dies on disk: nothing is moved until the marker at
 *      that path has been proved and the set inside it re-verified against the recorded identity.
 */
export function readSafetySetJournal(projectRoot: string): SafetySetJournal | null {
  const path = safetySetJournalPath(projectRoot);
  if (!existsSync(path)) return null;
  const refuse = (why: string): never => {
    throw new JournalRefusal(why);
  };
  try {
    return parseSafetySetJournal(projectRoot, path, refuse);
  } catch (err) {
    if (err instanceof JournalRefusal) {
      throw new MaintenanceRefused(
        `this project holds a safety-set lifecycle journal and ${err.message}. It was not written by a run of `
        + 'this program, so nothing here will act on it. Look at it, and remove it yourself once you are sure.');
    }
    if (err instanceof MaintenanceRefused) throw err;
    // A RUNTIME EXCEPTION IS A REFUSAL TOO. Anything escaping as a `TypeError` from a malformed member is
    // still "this document is not one of ours", and it must never reach a caller as an unhandled throw whose
    // message carries whatever the runtime chose to put in it.
    throw new MaintenanceRefused(
      'this project holds a safety-set lifecycle journal this build could not read as an operation. Nothing '
      + 'here will act on it. Look at it, and remove it yourself once you are sure.');
  }
}

function parseSafetySetJournal(
  projectRoot: string,
  path: string,
  refuse: (why: string) => never,
): SafetySetJournal {
  let raw: string;
  try {
    raw = readFileNoFollow(path, 'safety-set lifecycle journal', MAX_SAFETY_JOURNAL_BYTES).bytes.toString('utf8');
  } catch (err) {
    if (err instanceof MaintenanceRefused) throw err;
    return refuse('it could not be read');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse('it is not readable JSON');
  }
  if (!isRecord(parsed)) return refuse('it is not a record');
  const doc = parsed;

  // THE VERSION BOUNDARY IS FIRST, so a document from another schema is refused for BEING one rather than for
  // whichever field it happens to be missing.
  if (doc.journal !== 'catalog-authority.safety-set-lifecycle') return refuse('it is not this command\'s journal');
  if (doc.version !== SAFETY_SET_JOURNAL_VERSION) {
    return refuse(`its version is ${describe(doc.version)} and this build writes ${SAFETY_SET_JOURNAL_VERSION}`);
  }
  if (typeof doc.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.planDigest)) {
    return refuse('its plan digest is not a digest');
  }
  if (typeof doc.destination !== 'string' || doc.destination === '') return refuse('it records no destination');
  let resolvedDestination: ResolvedSafetySet;
  try {
    resolvedDestination = resolveSafetySetDestination(projectRoot, doc.destination);
  } catch {
    return refuse('the destination it records is not a directory inside this project');
  }
  if (typeof doc.suffix !== 'string' || !SAFETY_SUFFIX_RE.test(doc.suffix)) {
    return refuse('its run suffix is not one this command produces');
  }
  if (doc.phase !== 'removing' && doc.phase !== 'abandoning') {
    return refuse('its phase is not one this command writes');
  }
  const policy = validateSafetyPolicy(doc.policy, refuse);
  const evaluated = instantOf(doc.evaluatedAt);
  if (evaluated === null) return refuse('the instant it evaluated its decisions at is not an instant');
  for (const field of ['restorableRemaining', 'restorableTopLevel'] as const) {
    const value = doc[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_CLAIM_ENTRIES) {
      return refuse('a count of what it would leave is not a count');
    }
  }
  for (const field of ['protectedNewestRestorable', 'protectedNewestRollbackPoint'] as const) {
    const value = doc[field];
    if (value === null) continue;
    if (typeof value !== 'string' || !CLAIM_NAME_RE.test(value)) {
      return refuse('a claim it says it protected is neither a claim name nor absent');
    }
  }

  // EVERY MEMBER, BEFORE ANYTHING MAPS OVER ANY OF THEM.
  if (!Array.isArray(doc.claims)) return refuse('its claim inventory is not a list');
  if (doc.claims.length > MAX_CLAIM_ENTRIES) return refuse('it records more claims than this command inventories');
  const claims = doc.claims.map((row) => validateClaimEntry(row, refuse));
  if (new Set(claims.map((row) => row.name)).size !== claims.length) {
    return refuse('a name appears in its claim inventory more than once');
  }
  if (JSON.stringify(claims.map((row) => row.name))
    !== JSON.stringify(claims.map((row) => row.name).slice().sort())) {
    return refuse('its claim inventory is not in the canonical order this command lists a destination in');
  }

  if (!Array.isArray(doc.destinationSets)) return refuse('its destination inventory is not a list');
  if (doc.destinationSets.length > MAX_CLAIM_ENTRIES) {
    return refuse('it records more destination entries than this command inventories');
  }
  const destinationSets = doc.destinationSets.map((row) => validateInventoryEntry(row, refuse));
  if (new Set(destinationSets.map((row) => row.name)).size !== destinationSets.length) {
    return refuse('a name appears in its destination inventory more than once');
  }
  if (JSON.stringify(destinationSets.map((row) => row.name))
    !== JSON.stringify(destinationSets.map((row) => row.name).slice().sort())) {
    return refuse('its destination inventory is not in the canonical order this command lists a destination in');
  }

  if (!Array.isArray(doc.decisions)) return refuse('its decisions are not a list');
  const decisions = doc.decisions.map((row) => validateSafetyDecision(row, refuse));
  if (decisions.length !== claims.length) return refuse('its decisions do not cover its claim inventory');
  for (const [index, decision] of decisions.entries()) {
    if (decision.name !== claims[index]!.name) return refuse('its decisions are not its claim inventory, in order');
  }

  if (!Array.isArray(doc.removals)) return refuse('its removal list is not a list');
  const known = new Map(claims.map((row) => [row.name, row]));
  for (const name of doc.removals) {
    if (typeof name !== 'string') return refuse('a name in its removal list is not a name');
    if (!CLAIM_NAME_RE.test(name)) return refuse('a name in its removal list is not one this command creates');
    const row = known.get(name);
    if (row === undefined) return refuse('its removal list names something its own inventory does not');
    // THE CLASS GATE, BEFORE THE EVALUATOR IS EVEN ASKED. A document pointing this operation at a foreign
    // directory, a claim of another build, an in-flight one or one holding something unaccounted for is
    // refused for WHAT IT NAMES, not for what it computed.
    if (!REMOVABLE_CLAIM_CLASSES.includes(row.claimClass)) {
      return refuse('its removal list names something that is not a restore claim this build created');
    }
    if (row.claimClass === 'OWNED_UNVERIFIED' && !policy.includeUnverified) {
      return refuse('its removal list names a claim whose safety set does not verify, under a policy that did '
        + 'not admit one');
    }
    if (row.claimClass === 'OWNED_EMPTY' && !policy.includeEmptyClaims) {
      return refuse('its removal list names an empty claim, under a policy that did not admit one');
    }
  }
  const removals = doc.removals as readonly string[];
  if (new Set(removals).size !== removals.length) {
    return refuse('a name appears in its removal list more than once');
  }

  if (!Array.isArray(doc.entries)) return refuse('its per-claim states are not a list');
  if (doc.entries.length !== removals.length) return refuse('its per-claim states do not cover its removal list');
  const entries: SafetyJournalEntry[] = [];
  for (const [index, value] of doc.entries.entries()) {
    if (!isRecord(value)) return refuse('one of its per-claim states is not a record');
    if (value.name !== removals[index]) return refuse('its per-claim states are not its removal list, in order');
    if (typeof value.state !== 'string' || !SAFETY_ENTRY_STATES.includes(value.state as SafetyEntryState)) {
      return refuse('one of its per-claim states is not a state this command writes');
    }
    const state = value.state as SafetyEntryState;
    if (state === 'failed') {
      if (typeof value.reason !== 'string' || value.reason === '') return refuse('a failed claim carries no reason');
      if (value.reason.length > 2000) return refuse('a failure reason longer than this command writes');
    } else if (value.reason !== null) {
      return refuse('a claim that did not fail carries a failure reason');
    }
    // PRESENT EXACTLY WHEN THE STATE IS `deleting`, AND VALIDATED BEFORE ANYTHING IS CONCATENATED WITH IT.
    // A `deleting` entry with no consumption nonce describes a consumption whose live child cannot be
    // identified; one on any other state describes an authority this command never issues.
    if (state === 'deleting') {
      if (typeof value.consumeNonce !== 'string' || !CONSUME_NONCE_RE.test(value.consumeNonce)) {
        return refuse('a claim recorded as being removed carries no consumption nonce this command draws');
      }
    } else if (value.consumeNonce !== null) {
      return refuse('a claim that is not being removed carries a consumption nonce');
    }
    entries.push({
      name: value.name as string,
      state,
      reason: state === 'failed' ? (value.reason as string) : null,
      consumeNonce: state === 'deleting' ? (value.consumeNonce as string) : null,
    });
  }

  // THE DOCUMENT AGREES WITH ITSELF...
  const journal: SafetySetJournal = {
    journal: 'catalog-authority.safety-set-lifecycle',
    version: SAFETY_SET_JOURNAL_VERSION,
    planDigest: doc.planDigest,
    destination: doc.destination,
    suffix: doc.suffix,
    policy,
    evaluatedAt: evaluated.takenAt,
    claims,
    destinationSets,
    decisions,
    removals,
    protectedNewestRestorable: doc.protectedNewestRestorable as string | null,
    protectedNewestRollbackPoint: doc.protectedNewestRollbackPoint as string | null,
    restorableRemaining: doc.restorableRemaining as number,
    restorableTopLevel: doc.restorableTopLevel as number,
    entries,
    phase: doc.phase,
  };
  const recomputed = digestSafetySetOperation(canonicalSafetySetOperation(
    resolvedDestination, journal.policy, journal.claims, journal.destinationSets, journal.decisions,
    journal.removals, journal.protectedNewestRestorable, journal.protectedNewestRollbackPoint,
    journal.restorableRemaining, journal.restorableTopLevel));
  if (recomputed !== journal.planDigest) {
    return refuse('the operation it describes does not hash to the plan digest it records');
  }

  // ...AND THE EVALUATOR AGREES WITH THE DOCUMENT. This is the only check that is not a question the document
  // gets to answer about itself.
  let independent;
  try {
    independent = evaluateSafetySetLifecycle(journal.claims, journal.destinationSets, journal.policy,
      new Date(evaluated.takenAtMs));
  } catch {
    return refuse('the decisions it records cannot be evaluated at all');
  }
  if (independent.refusals.length > 0) {
    return refuse('the operation it describes is one this command refuses to perform');
  }
  if (JSON.stringify(independent.decisions) !== JSON.stringify(journal.decisions)) {
    return refuse('the decisions it records are not the ones this build makes from the inventory it records');
  }
  if (JSON.stringify(independent.removals) !== JSON.stringify(journal.removals)) {
    return refuse('the removals it records are not the ones this build makes from the inventory it records');
  }
  if (independent.protectedNewestRestorable !== journal.protectedNewestRestorable
    || independent.protectedNewestRollbackPoint !== journal.protectedNewestRollbackPoint) {
    return refuse('a claim it says it protected is not one this build protects');
  }
  if (independent.restorableRemaining !== journal.restorableRemaining
    || independent.restorableTopLevel !== journal.restorableTopLevel) {
    return refuse('a count it records is not the one this build computes');
  }
  return journal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value) : typeof value;
}

function validateSafetyPolicy(value: unknown, refuse: (why: string) => never): SafetySetPolicy {
  if (!isRecord(value)) return refuse('it records no policy');
  const whole = (candidate: unknown, max: number): boolean =>
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 && candidate <= max;
  if (!whole(value.keepLast, MAX_SAFETY_KEEP_LAST) || !whole(value.minAgeDays, MAX_SAFETY_MIN_AGE_DAYS)
    || !whole(value.keepMinimumRestorable, MAX_SAFETY_KEEP_MINIMUM)
    || typeof value.includeUnverified !== 'boolean' || typeof value.includeEmptyClaims !== 'boolean') {
    return refuse('the policy it records is not one this command accepts');
  }
  const policy: SafetySetPolicy = {
    keepLast: value.keepLast as number,
    minAgeDays: value.minAgeDays as number,
    includeUnverified: value.includeUnverified,
    includeEmptyClaims: value.includeEmptyClaims,
    keepMinimumRestorable: value.keepMinimumRestorable as number,
  };
  try {
    assertUsableSafetyPolicy(policy);
  } catch {
    return refuse('the policy it records is not one this command accepts');
  }
  return policy;
}

/** Every field of a claim row, checked before anything reads any of them. */
export function validateClaimEntry(value: unknown, refuse: (why: string) => never): ClaimInventoryEntry {
  if (!isRecord(value)) return refuse('one of its claim rows is not a record');
  if (typeof value.name !== 'string' || value.name === '' || value.name.length > 128) {
    return refuse('one of its claim rows has no usable name');
  }
  if (typeof value.claimClass !== 'string' || !CLAIM_CLASSES.includes(value.claimClass as ClaimClass)) {
    return refuse('one of its claim rows carries a class this build does not write');
  }
  if (typeof value.evidence !== 'string' || !CLAIM_EVIDENCE.includes(value.evidence as ClaimEvidence)) {
    return refuse('one of its claim rows carries evidence this build does not write');
  }
  const claimClass = value.claimClass as ClaimClass;
  const proved = REMOVABLE_CLAIM_CLASSES.includes(claimClass) || claimClass === 'OWNED_IN_FLIGHT'
    || claimClass === 'OWNED_UNEXPECTED';
  // A PROVED CLAIM HAS A NONCE AND A CLAIM DIGEST, AND ONE THAT IS NOT PROVED HAS NEITHER. A row claiming
  // otherwise is not a row this build produced.
  if (proved) {
    if (typeof value.nonce !== 'string' || !SAFETY_CLAIM_NONCE_RE.test(value.nonce)) {
      return refuse('one of its claim rows is recorded as proved and carries no nonce');
    }
    if (typeof value.claimDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.claimDigest)) {
      return refuse('one of its claim rows is recorded as proved and carries no marker digest');
    }
    if (value.name !== safetySetClaimDirName(value.nonce)) {
      return refuse('one of its claim rows carries a nonce that does not name it');
    }
  } else {
    if (value.nonce !== null) return refuse('one of its claim rows claims a nonce for something not proved ours');
    if (value.claimDigest !== '') {
      return refuse('one of its claim rows claims a marker digest for something not proved ours');
    }
  }
  if (value.setName !== null) {
    if (typeof value.setName !== 'string') return refuse('one of its claim rows has an unusable safety set name');
    try {
      assertUsableName(value.setName, 'safety set name');
    } catch {
      return refuse('one of its claim rows has an unusable safety set name');
    }
  }
  const datedBoth = value.takenAt === null && value.takenAtMs === null;
  if (!datedBoth) {
    const instant = instantOf(value.takenAt);
    if (instant === null) return refuse('one of its claim rows carries a date that is not an instant');
    if (value.takenAtMs !== instant.takenAtMs) {
      return refuse('one of its claim rows carries a date and a moment that disagree');
    }
  }
  if (value.schemaVersion !== null
    && !(typeof value.schemaVersion === 'number' && Number.isInteger(value.schemaVersion)
      && value.schemaVersion >= 0 && value.schemaVersion <= 100000)) {
    return refuse('one of its claim rows carries a schema version that is not one');
  }
  if (typeof value.setDigest !== 'string' || !/^([0-9a-f]{64})?$/.test(value.setDigest)) {
    return refuse('one of its claim rows carries a set digest that is not one');
  }
  if (typeof value.restorable !== 'boolean') {
    return refuse('one of its claim rows does not say whether it is restorable');
  }
  for (const field of ['bytes', 'entries'] as const) {
    const candidate = value[field];
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0
      || candidate > Number.MAX_SAFE_INTEGER) {
      return refuse(`one of its claim rows carries a ${field} count that is not a count`);
    }
  }
  if (value.observedAtMs !== null
    && !(typeof value.observedAtMs === 'number' && Number.isInteger(value.observedAtMs)
      && value.observedAtMs >= 0 && value.observedAtMs <= Number.MAX_SAFE_INTEGER)) {
    return refuse('one of its claim rows carries a modification time that is not one');
  }
  if (!Array.isArray(value.findings) || value.findings.length > 64
    || value.findings.some((finding) => typeof finding !== 'string' || finding.length > 64)) {
    return refuse('one of its claim rows carries findings this build does not write');
  }
  // ONLY A CLAIM HOLDING A READABLE SET HAS A DIGEST OR CAN BE RESTORABLE.
  const holdsSet = claimClass === 'OWNED_SET' || claimClass === 'OWNED_UNVERIFIED';
  if (!holdsSet && value.setDigest !== '') {
    return refuse('one of its claim rows claims a set digest for a claim that holds no set');
  }
  if (claimClass !== 'OWNED_SET' && value.restorable) {
    return refuse('one of its claim rows claims something that is not a complete safety set is restorable');
  }
  return {
    name: value.name,
    claimClass,
    evidence: value.evidence as ClaimEvidence,
    nonce: value.nonce as string | null,
    claimDigest: value.claimDigest as string,
    setName: value.setName as string | null,
    setDigest: value.setDigest,
    takenAt: value.takenAt as string | null,
    takenAtMs: value.takenAtMs as number | null,
    schemaVersion: value.schemaVersion as number | null,
    restorable: value.restorable,
    bytes: value.bytes as number,
    entries: value.entries as number,
    findings: (value.findings as readonly string[]).slice(),
    observedAtMs: value.observedAtMs as number | null,
  };
}

function validateSafetyDecision(value: unknown, refuse: (why: string) => never): SafetySetDecision {
  if (!isRecord(value)) return refuse('one of its decisions is not a record');
  if (typeof value.name !== 'string' || value.name === '' || value.name.length > 128) {
    return refuse('one of its decisions has no usable name');
  }
  if (value.decision !== 'keep' && value.decision !== 'remove') {
    return refuse('one of its decisions is neither keep nor remove');
  }
  if (typeof value.reason !== 'string' || !SAFETY_SET_REASONS.includes(value.reason as never)) {
    return refuse('one of its decisions carries a reason this build does not write');
  }
  return { name: value.name, decision: value.decision, reason: value.reason as SafetySetDecision['reason'] };
}

export function writeSafetySetJournal(projectRoot: string, journal: SafetySetJournal): void {
  // STAGED AND RENAMED, so a reader sees the previous complete journal or the new one and never a prefix.
  const staging = join(projectRoot, `${SAFETY_SET_JOURNAL_NAME}.writing-${stagingSuffix()}`);
  const text = `${JSON.stringify(journal, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_SAFETY_JOURNAL_BYTES) {
    throw new MaintenanceRefused('this operation would produce a journal larger than this command reads back');
  }
  writePrivateFile(staging, text, 'safety-set lifecycle journal');
  try {
    renameSync(staging, safetySetJournalPath(projectRoot));
  } catch {
    try { unlinkSync(staging); } catch { /* the staging file is diagnostic; a failed cleanup is not the failure */ }
    throw new MaintenanceRefused(
      'the safety-set lifecycle journal could not be published into the project directory');
  }
}

export function clearSafetySetJournal(projectRoot: string): void {
  try {
    unlinkSync(safetySetJournalPath(projectRoot));
  } catch {
    throw new MaintenanceRefused('the safety-set lifecycle journal could not be removed from the project directory');
  }
}

// -----------------------------------------------------------------------------------------------------------
// The quarantine directory, and what makes it OURS
// -----------------------------------------------------------------------------------------------------------

/** What this operation committed to about one claim. Compared WHOLE, never field by field at a call site. */
export interface SafetyCommitment {
  readonly name: string;
  readonly nonce: string;
  readonly claimDigest: string;
  readonly setName: string | null;
  readonly setDigest: string;
  readonly takenAt: string | null;
  readonly schemaVersion: number | null;
  readonly bytes: number;
  readonly entries: number;
  readonly verified: boolean;
  readonly findings: readonly string[];
}

export interface SafetyQuarantineMarker {
  readonly marker: 'catalog-authority.safety-set-quarantine';
  readonly version: 1;
  readonly journalVersion: typeof SAFETY_SET_JOURNAL_VERSION;
  readonly planDigest: string;
  readonly suffix: string;
  readonly removals: readonly string[];
  readonly commitments: readonly SafetyCommitment[];
}

export function safetyQuarantineMarkerPath(quarantineDir: string): string {
  return join(quarantineDir, SAFETY_QUARANTINE_MARKER_NAME);
}

export function commitmentsOf(journal: SafetySetJournal): readonly SafetyCommitment[] {
  const known = new Map(journal.claims.map((row) => [row.name, row]));
  return journal.removals.map((name) => {
    const row = known.get(name);
    if (row === undefined) throw new MaintenanceRefused('this operation names a claim its own inventory does not');
    return {
      name,
      nonce: row.nonce ?? '',
      claimDigest: row.claimDigest,
      setName: row.setName,
      setDigest: row.setDigest,
      takenAt: row.takenAt,
      schemaVersion: row.schemaVersion,
      bytes: row.bytes,
      entries: row.entries,
      verified: row.claimClass === 'OWNED_SET',
      findings: [...row.findings],
    };
  });
}

function expectedQuarantineMarker(journal: SafetySetJournal): SafetyQuarantineMarker {
  return {
    marker: 'catalog-authority.safety-set-quarantine',
    version: 1,
    journalVersion: SAFETY_SET_JOURNAL_VERSION,
    planDigest: journal.planDigest,
    suffix: journal.suffix,
    removals: [...journal.removals],
    commitments: commitmentsOf(journal),
  };
}

/**
 * Prove the directory at the quarantine path is THIS operation's.
 *
 * AN UNPREDICTABLE NAME IS NOT OWNERSHIP. The suffix is written down in the journal, in a directory the
 * operator owns, so after a crash it is PUBLISHED rather than unguessable — and an allowlist of child names is
 * not ownership either, because the planned names are published in exactly the same place. A marker inside the
 * tree, bound to the journal version, the plan digest, the suffix, the ordered removal list and every claim's
 * exact commitment, compared WHOLE, is what ownership means here.
 */
export function readSafetyQuarantineMarker(
  quarantineDir: string,
  journal: SafetySetJournal,
): { readonly ok: true; readonly marker: SafetyQuarantineMarker } | { readonly ok: false; readonly why: string } {
  const path = safetyQuarantineMarkerPath(quarantineDir);
  if (!existsSync(path)) {
    return { ok: false, why: 'the quarantine directory carries no ownership marker of this operation\'s' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileNoFollow(path, 'safety-set quarantine marker', 4 * 1024 * 1024)
      .bytes.toString('utf8'));
  } catch {
    return { ok: false, why: 'the quarantine directory\'s ownership marker could not be read' };
  }
  if (!isRecord(parsed)) return { ok: false, why: 'the quarantine directory\'s ownership marker is not a record' };
  // COMPARED WHOLE, AGAINST WHAT THIS OPERATION WOULD HAVE WRITTEN. Field-by-field leniency is how a marker
  // that names the right operation while describing different claims ends up authorising a deletion.
  const want = JSON.stringify(expectedQuarantineMarker(journal));
  const have = JSON.stringify({
    marker: parsed.marker, version: parsed.version, journalVersion: parsed.journalVersion,
    planDigest: parsed.planDigest, suffix: parsed.suffix, removals: parsed.removals,
    commitments: parsed.commitments,
  });
  if (want !== have) {
    return { ok: false, why: 'the quarantine directory\'s ownership marker does not describe this operation' };
  }
  return { ok: true, marker: expectedQuarantineMarker(journal) };
}

/**
 * Create the quarantine directory, ALREADY MARKED, in one atomic publication.
 *
 * The predictable path goes from ABSENT straight to a directory holding a valid marker of this operation's:
 * the tree is built under an unpredictable, secret-free name, the marker is written inside it while it is
 * still invisible, and only then is it renamed into place. Not one byte of any claim is moved until after
 * that rename, so the path is never observable in a state a reader has to guess about.
 */
function publishSafetyQuarantine(
  destinationDir: string,
  quarantineDir: string,
  journal: SafetySetJournal,
  at: (point: SafetyFailpoint, name: string) => void,
): void {
  const claim = join(destinationDir, `${SAFETY_QUARANTINE_CLAIM_PREFIX}${randomBytes(9).toString('hex')}`);
  createPrivateDirectory(claim, 'safety-set quarantine claim directory');
  writePrivateFile(safetyQuarantineMarkerPath(claim),
    `${JSON.stringify(expectedQuarantineMarker(journal), null, 2)}\n`, 'safety-set quarantine marker');
  at('after-quarantine-marker-built', '');
  if (existsSync(quarantineDir)) {
    throw new MaintenanceRefused(
      'the safety-set quarantine name is already taken by something this operation did not publish');
  }
  try {
    renameSync(claim, quarantineDir);
  } catch {
    throw new MaintenanceRefused('the safety-set quarantine directory could not be published');
  }
  at('after-quarantine-marker-published', '');
}

/**
 * The quarantine directory this operation may use, published if it is not there and proved if it is.
 *
 * A directory at the predictable path that cannot prove it is ours is never written into, never read from and
 * never removed — the operation stops instead.
 */
function requireSafetyQuarantine(
  destinationDir: string,
  journal: SafetySetJournal,
  at: (point: SafetyFailpoint, name: string) => void,
): string {
  const quarantineDir = join(destinationDir, safetyQuarantineDirName(journal.suffix));
  if (!existsSync(quarantineDir)) {
    publishSafetyQuarantine(destinationDir, quarantineDir, journal, at);
    return quarantineDir;
  }
  const stats = lstatSync(quarantineDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new MaintenanceRefused('the safety-set quarantine name is held by something that is not a directory');
  }
  const proof = readSafetyQuarantineMarker(quarantineDir, journal);
  if (!proof.ok) {
    throw new MaintenanceRefused(
      `${proof.why}. Nothing was moved into it and nothing inside it was removed. This is a state one run `
      + 'cannot produce, so this command stopped rather than guessing whose directory it is.');
  }
  // NOTHING INSIDE IT THAT THIS OPERATION DID NOT PUT THERE.
  const planned = new Set([...journal.removals, SAFETY_QUARANTINE_MARKER_NAME]);
  for (const entry of readdirSync(quarantineDir)) {
    if (!planned.has(entry)) {
      throw new MaintenanceRefused(
        'the safety-set quarantine directory holds something this operation did not put there, so nothing more '
        + 'was moved into it and nothing in it was removed');
    }
  }
  return quarantineDir;
}

// -----------------------------------------------------------------------------------------------------------
// The consumption marker — live ownership of the ONE CHILD being destroyed
// -----------------------------------------------------------------------------------------------------------

export interface SafetyConsumingMarker {
  readonly marker: 'catalog-authority.safety-set-consuming';
  readonly version: 1;
  readonly journalVersion: typeof SAFETY_SET_JOURNAL_VERSION;
  readonly planDigest: string;
  readonly suffix: string;
  /** The claim this marker authorises consuming. A marker for another claim authorises nothing here. */
  readonly claim: string;
  /** Drawn per consumption, from the system CSPRNG, and persisted in the journal entry. */
  readonly consumeNonce: string;
  /** What this operation committed to about the claim, so a marker cannot be carried to a different one. */
  readonly commitment: SafetyCommitment;
}

export function consumingMarkerPath(claimDir: string): string {
  return join(claimDir, SAFETY_CONSUMING_MARKER_NAME);
}

export function expectedConsumingMarker(
  journal: SafetySetJournal,
  commitment: SafetyCommitment,
  consumeNonce: string,
): SafetyConsumingMarker {
  if (!CONSUME_NONCE_RE.test(consumeNonce)) {
    throw new MaintenanceRefused('the consumption nonce is not one this command draws');
  }
  return {
    marker: 'catalog-authority.safety-set-consuming',
    version: 1,
    journalVersion: SAFETY_SET_JOURNAL_VERSION,
    planDigest: journal.planDigest,
    suffix: journal.suffix,
    claim: commitment.name,
    consumeNonce,
    commitment,
  };
}

/** Is there anything at the consumption marker's name? Asked WITHOUT following a link. */
export function consumingMarkerPresent(claimDir: string): boolean {
  return lstatSync(consumingMarkerPath(claimDir), { throwIfNoEntry: false }) !== undefined;
}

/** A directory holding nothing at all. Unreadable answers `false`, because unknown is not empty. */
export function isEmptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/**
 * Prove the tree at `claimDir` is the one THIS consumption began on.
 *
 * Compared WHOLE against what this operation would have written, for the same reason the quarantine marker
 * is: field-by-field leniency is how a marker that names the right operation while describing a different
 * claim ends up authorising a deletion.
 */
export function readConsumingMarker(
  claimDir: string,
  journal: SafetySetJournal,
  commitment: SafetyCommitment,
  consumeNonce: string,
): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  const path = consumingMarkerPath(claimDir);
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    return { ok: false, why: 'this claim carries no consumption marker of this operation\'s' };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { ok: false, why: 'this claim\'s consumption marker is not a plain file' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileNoFollow(path, 'safety-set consumption marker', 4 * 1024 * 1024)
      .bytes.toString('utf8'));
  } catch {
    return { ok: false, why: 'this claim\'s consumption marker could not be read' };
  }
  if (!isRecord(parsed)) return { ok: false, why: 'this claim\'s consumption marker is not a record' };
  const want = JSON.stringify(expectedConsumingMarker(journal, commitment, consumeNonce));
  const have = JSON.stringify({
    marker: parsed.marker, version: parsed.version, journalVersion: parsed.journalVersion,
    planDigest: parsed.planDigest, suffix: parsed.suffix, claim: parsed.claim,
    consumeNonce: parsed.consumeNonce, commitment: parsed.commitment,
  });
  if (want !== have) {
    return { ok: false, why: 'this claim\'s consumption marker does not describe this consumption' };
  }
  return { ok: true };
}

export function writeConsumingMarker(
  claimDir: string,
  journal: SafetySetJournal,
  commitment: SafetyCommitment,
  consumeNonce: string,
): void {
  writePrivateFile(consumingMarkerPath(claimDir),
    `${JSON.stringify(expectedConsumingMarker(journal, commitment, consumeNonce), null, 2)}\n`,
    'safety-set consumption marker');
}

/**
 * Remove a claim this operation is consuming, KEEPING ITS AUTHORITY ALIVE UNTIL LAST.
 *
 * The invariant the whole recovery rests on is that a partially consumed tree still carries its consumption
 * marker, so the marker cannot be removed by a walk that visits children in whatever order the filesystem
 * hands them back. It is unlinked explicitly, after everything else, immediately before the directory itself.
 *
 * IT ALSO RE-CHECKS THE MEMBERSHIP IT IS ABOUT TO WALK. A consumed claim holds at most three things: the
 * restore's ownership marker, this operation's consumption marker and the one safety set the commitment
 * names. Anything else appearing inside it is refused rather than walked — the bound from the manifest is
 * about SIZE, and this is about SHAPE, and a tree that grew a member is not the tree this operation proved.
 */
function removeConsumedClaim(
  claimDir: string,
  commitment: SafetyCommitment,
  remove: (path: string, what: string, maxEntries: number) => number,
): void {
  let members: readonly string[];
  try {
    members = readdirSync(claimDir).slice().sort();
  } catch {
    throw new MaintenanceRefused('this claim could not be listed, so nothing was removed for it');
  }
  const allowed = new Set([SAFETY_CLAIM_MARKER_NAME, SAFETY_CONSUMING_MARKER_NAME,
    ...(commitment.setName === null ? [] : [commitment.setName])]);
  for (const member of members) {
    if (!allowed.has(member)) {
      throw new MaintenanceRefused(
        'this claim holds something this operation did not put there and did not commit to removing, so '
        + 'nothing in it was removed');
    }
  }
  // THE SAFETY SET FIRST, through the shipped no-follow bounded removal. Its bound comes from what the
  // manifest declared the set to be.
  if (commitment.setName !== null && members.includes(commitment.setName)) {
    remove(join(claimDir, commitment.setName), `safety set ${commitment.setName}`,
      removalEntryBound(commitment.entries));
  }
  // THEN THE RESTORE'S OWN MARKER, then this operation's authority, then the directory. `unlink` never
  // follows a link, so even one created in the window between the listing and the removal is unlinked as a
  // link rather than followed to somebody else's bytes.
  for (const member of [SAFETY_CLAIM_MARKER_NAME, SAFETY_CONSUMING_MARKER_NAME]) {
    if (lstatSync(join(claimDir, member), { throwIfNoEntry: false }) === undefined) continue;
    try {
      unlinkSync(join(claimDir, member));
    } catch {
      throw new MaintenanceRefused('this claim could not be removed in full');
    }
  }
  try {
    rmdirSync(claimDir);
  } catch {
    throw new MaintenanceRefused('this claim could not be removed in full');
  }
}

/**
 * Prove the tree at `path` is EXACTLY the claim this operation planned to remove.
 *
 * TWO PROOFS, AND BOTH ARE NEEDED. The claim's own marker says which restore created it and which nonce it
 * was created under — that is what makes the directory ours. The safety set inside it is then proved against
 * the identity recorded when the plan was made, by the same primitive `ops:backup-retention` uses, so a claim
 * whose set was replaced, mutated, truncated or swapped for a different set of ours is refused.
 *
 * A CLAIM RECORDED AS EMPTY IS PROVED EMPTY. "It held nothing when we looked" is a commitment like any other,
 * and a claim that has since had a backup set published into it is not the claim that was planned.
 */
export function proveClaimIsPlanned(path: string, want: SafetyCommitment): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new MaintenanceRefused('this claim could not be examined, so nothing was removed for it');
  }
  if (stats.isSymbolicLink()) {
    throw new MaintenanceRefused('this claim is a symbolic link, and this command will not remove through one');
  }
  if (!stats.isDirectory()) throw new MaintenanceRefused('this claim is not a directory, so it was left alone');
  // THE OWNERSHIP MARKER IS CHECKED AT THE NAME THE CLAIM HAS RIGHT NOW. Inside the quarantine directory the
  // claim keeps its own name, which is what lets the nonce and the directory keep agreeing.
  const reading = readRestoreClaimMarker(path, basename(path), CLAIM_MARKER_EXPECTATION);
  if (!reading.ok) {
    throw new MaintenanceRefused(
      'this claim can no longer prove a restore of this build created it, so nothing was removed for it');
  }
  if (reading.identity.nonce !== want.nonce || reading.identity.planDigest !== want.claimDigest) {
    throw new MaintenanceRefused(
      'this claim is not the one this operation planned to remove — the ownership marker inside it names a '
      + 'different restore. Nothing was removed for it.');
  }
  let members: readonly string[];
  try {
    members = readdirSync(path).slice().sort().filter((entry) => entry !== SAFETY_CLAIM_MARKER_NAME);
  } catch {
    throw new MaintenanceRefused('this claim could not be listed again, so nothing was removed for it');
  }
  if (want.setName === null) {
    if (members.length !== 0) {
      throw new MaintenanceRefused(
        'this claim was recorded as holding no safety set and now holds something. Nothing was removed for it.');
    }
    return;
  }
  if (members.length !== 1 || members[0] !== want.setName) {
    throw new MaintenanceRefused(
      'this claim no longer holds exactly the safety set it held when the plan was made. Nothing was removed '
      + 'for it.');
  }
  const commitment: BackupSetCommitment = {
    name: want.setName,
    setDigest: want.setDigest,
    takenAt: want.takenAt,
    schemaVersion: want.schemaVersion,
    bytes: want.bytes,
    entries: want.entries,
    verified: want.verified,
    findings: want.findings,
  };
  proveBackupSetIdentity(join(path, want.setName), commitment);
}

// -----------------------------------------------------------------------------------------------------------
// Phase 317 — execution
// -----------------------------------------------------------------------------------------------------------

/**
 * Every combination of a recorded per-claim state and what the filesystem actually holds, and the one answer
 * to each — `null` for a state a run of this program can be in, a closed sentence for one it cannot.
 *
 * TOTAL AND EXPORTED. Five states times two presences times two presences is TWENTY combinations; eight are
 * legal and twelve are not. It is a function rather than a comment so the executor and the suite read the
 * SAME table, and a state added to the executor without an answer here is visible rather than silently
 * defaulting to "carry on".
 */
export function safetyPreconditionRefusal(
  state: SafetyEntryState,
  inDestination: boolean,
  inQuarantine: boolean,
): string | null {
  // BOTH PLACES IS NEVER LEGAL, in any state. One run cannot produce it, and guessing which of the two is the
  // real claim is exactly the guess this family never makes.
  if (inDestination && inQuarantine) {
    return 'this claim is present both in the destination and in the quarantine directory, which one run '
      + 'cannot produce. Nothing was removed for it, and nothing after it was touched.';
  }
  switch (state) {
    case 'pending':
    case 'failed':
      // `failed` IS `pending` WITH A HISTORY. It is only ever written for an entry that had NOT reached
      // `deleting` — see `stop` — so its tree, wherever it is, is whole.
      if (!inDestination && !inQuarantine) {
        return 'this claim is in neither the destination nor the quarantine directory. Something removed it '
          + 'outside this command, and this run will not report having removed it.';
      }
      return null;
    case 'quarantined':
      if (inDestination) {
        return 'this claim is recorded as set aside and is back in the destination, which one run cannot produce.';
      }
      if (!inQuarantine) {
        return 'this claim was recorded as set aside and is no longer in the quarantine directory. Nothing '
          + 'this command does removes a claim without recording that it was about to, so something else did. '
          + 'Nothing after it was touched.';
      }
      return null;
    case 'deleting':
      if (inDestination) {
        return 'this claim is recorded as being removed and is back in the destination, which one run cannot '
          + 'produce.';
      }
      // PRESENT: a tree that may be partial, finished under the ownership marker. ABSENT: the removal landed
      // and its record did not. Both are states a kill really produces.
      return null;
    case 'removed':
      if (inDestination || inQuarantine) {
        return 'this claim is recorded as REMOVED and something is at its name again. This operation destroyed '
          + 'it, so whatever is there now is not the claim that was planned and is not this command\'s to act '
          + 'on. Nothing after it was touched. Close this operation with --abandon, then plan a fresh one.';
      }
      return null;
  }
}

/** Named boundaries a test kills a real run at. Never used in production; the default hook does nothing. */
export type SafetyFailpoint =
  | 'after-journal'
  | 'after-quarantine-marker-built'
  | 'after-quarantine-marker-published'
  | 'after-quarantine-rename'
  | 'after-quarantine-mark'
  | 'after-floor-proof'
  | 'after-deleting-mark'
  | 'after-consuming-marker'
  | 'after-remove'
  | 'after-abandon-rename';

export interface SafetySetDeps {
  readonly now?: () => Date;
  readonly suffix?: () => string;
  /** A hook the acceptance suite uses to stop a REAL run at a named boundary. */
  readonly at?: (point: SafetyFailpoint, name: string) => void;
  /** The journal writer, injectable because a journal that CANNOT BE WRITTEN is the failure that arrives
   * after claims have already moved, and there is no other way to produce it deterministically. */
  readonly journalWriter?: (projectRoot: string, journal: SafetySetJournal) => void;
  /** The journal clear, injectable for the same reason. */
  readonly journalClearer?: (projectRoot: string) => void;
  /** The recursive removal, injectable because a removal that unlinks SOME children and then throws is the
   * state `deleting` exists for, and a kill cannot be aimed between two `unlink` calls inside a primitive. */
  readonly remover?: (path: string, what: string, maxEntries: number) => number;
}

/**
 * A failure that happened AFTER this command had already moved or removed something.
 *
 * Every failure leaving through the ordinary `throw` reaches the CLI's refusal path, which exits with the
 * code this command documents as "refused before anything was moved". A scheduler or an operator reading that
 * code would be told nothing happened by a run that had already deleted safety sets.
 */
export class SafetySetFailed extends MaintenanceRefused {
  readonly report: SafetySetRunReport;

  constructor(message: string, report: SafetySetRunReport) {
    super(message);
    this.name = 'SafetySetFailed';
    this.report = report;
  }
}

/** The same, for an abandon: a rename happened and then something else did not. */
export class SafetySetAbandonFailed extends MaintenanceRefused {
  readonly report: SafetySetAbandonReport;

  constructor(message: string, report: SafetySetAbandonReport) {
    super(message);
    this.name = 'SafetySetAbandonFailed';
    this.report = report;
  }
}

export type SafetySetMode =
  | { readonly kind: 'run'; readonly confirm: string }
  | { readonly kind: 'resume'; readonly confirm: string };

export interface SafetyRetainedArtifacts {
  /** The quarantine directory's own name inside the destination. Never a path. */
  readonly quarantine: string;
  readonly holds: readonly string[];
  readonly warning: string;
}

export type SafetySetState = 'REMOVED' | 'REMOVED_BUT_UNPROVEN' | 'INCOMPLETE';

export interface SafetySetRunReport {
  readonly report: typeof SAFETY_SET_REPORT;
  readonly version: typeof SAFETY_SET_VERSION;
  readonly ok: boolean;
  readonly state: SafetySetState;
  readonly destinationName: string;
  readonly policy: SafetySetPolicy;
  readonly planDigest: string;
  readonly planned: readonly string[];
  readonly removed: readonly string[];
  readonly failed: readonly { readonly name: string; readonly reason: string }[];
  /** Named removals this run deliberately did not touch after it stopped. Abandon is still available for them. */
  readonly untouched: readonly string[];
  /** How many restore claims this destination still holds. Claims, not directory entries. */
  readonly claimsKept: number;
  readonly protectedNewestRestorable: string | null;
  /** The protected claim's safety set, re-verified FROM DISK after every removal. */
  readonly protectedNewestRestorableVerified: boolean;
  readonly protectedNewestRollbackPoint: string | null;
  /**
   * Why the run stopped before its FIRST deletion, when it did.
   *
   * It is its own field rather than a per-claim failure because it is not about a claim: it is the live
   * recount of what this destination could still restore from, and it stops every deletion rather than one.
   */
  readonly haltedBeforeDeleting: string | null;
  readonly restorableProvenBeforeDeleting: number | null;
  readonly bytesRemoved: number;
  readonly retained: SafetyRetainedArtifacts | null;
  readonly journalCleared: boolean;
  readonly commands: 'none';
  readonly network: 'none';
  readonly notes: readonly string[];
}

/**
 * Remove restore-created safety sets according to a policy an operator read and confirmed.
 *
 * THE ORDER IS THE GUARANTEE:
 *   1. resolve, and refuse a project part way through a restore or a prune
 *   2. take the PROJECT lock, then the DESTINATION lock — always that order, and they are the SAME two lock
 *      domains, in the same order, that `ops:backup-retention` takes, so no new lock order exists and two
 *      commands cannot deadlock against each other
 *   3. re-inventory and re-verify from scratch UNDER THE LOCK, and require the plan digest to be the one that
 *      was confirmed
 *   4. journal the whole committed decision list before the first effect
 *   5. publish an OWNED quarantine directory, then rename every removal into it, oldest first — reversible,
 *      and nothing is destroyed yet
 *   6. RE-PROVE THE FLOOR FROM LIVE DISK, immediately before the first irreversible act
 *   7. for each, prove the claim is the one that was planned, record `deleting`, then remove it
 *   8. re-verify, from disk, the safety set this run promised to protect
 *   9. release both locks in a `finally`, innermost first
 *
 * AND ANY IMPOSSIBLE STATE STOPS IT. Once the filesystem or the ownership evidence says something one run
 * cannot have produced, this does not carry on destroying the other candidates.
 */
export function runSafetySetLifecycle(
  request: SafetySetRequest,
  policy: SafetySetPolicy,
  deps: SafetySetDeps,
  mode: SafetySetMode,
): SafetySetRunReport {
  const now = deps.now ?? (() => new Date());
  const at = deps.at ?? (() => { /* production does nothing here */ });
  const writeJournal = deps.journalWriter ?? writeSafetySetJournal;
  const clearJournal = deps.journalClearer ?? clearSafetySetJournal;
  const remove = deps.remover ?? removeOwnTreeNoFollow;
  // A CHEAP, HOPELESS-CASE REFUSAL BEFORE THE LOCK, re-established under it below. Both are needed: this one
  // so a project part way through another operation refuses without contending for anything, that one because
  // a check made before a lock is a check about a moment that has passed.
  const projectRoot = resolveSafetySetProject(request.projectRoot);

  const locks = MaintenanceLocks.open(projectRoot);
  try {
    assertNoOtherOperationInProgress(projectRoot);
    const existing = readSafetySetJournal(projectRoot);
    if (mode.kind === 'run' && existing !== null) {
      throw new MaintenanceRefused(
        'this project holds an interrupted safety-set lifecycle journal. A destination part way through one is '
        + 'not a starting point, and re-planning over it would decide against an inventory that is missing the '
        + 'claims the interrupted run already set aside. Continue it with --resume, or unwind it with --abandon.');
    }
    if (mode.kind === 'resume') {
      if (existing === null) {
        throw new MaintenanceRefused('there is no interrupted safety-set lifecycle run in this project to resume');
      }
      if (existing.phase === 'abandoning') {
        throw new MaintenanceRefused(
          'this project\'s safety-set lifecycle journal records an interrupted ABANDON. Continuing would destroy '
          + 'claims an operator had just decided to put back. Finish it with --abandon.');
      }
      if (existing.planDigest !== mode.confirm) {
        throw new MaintenanceRefused(
          '--resume was given a digest that is not the interrupted run\'s. A resume continues the operation the '
          + 'journal recorded, and nothing else.');
      }
    }

    // A RESUME'S DESTINATION COMES FROM THE JOURNAL, NOT FROM A COMMAND LINE.
    const resolved = mode.kind === 'resume'
      ? resolveSafetySetDestination(projectRoot, existing!.destination)
      : resolveSafetySetDestination(projectRoot, request.destination);

    // THE SECOND LOCK DOMAIN IS SHARED WITH ALL THREE OTHER BACKUP-FAMILY COMMANDS, ON PURPOSE. Every one of
    // them renames, publishes, reads or removes directories inside one backup destination, so sharing one
    // lock taken IN that destination is what makes "two commands cannot be half way through one destination
    // at once" true rather than hoped for. It is taken second, after the project lock, through the same
    // `MaintenanceLocks` stack every command uses: same domains, same order, no way to invert it, no
    // deadlock. Phases 321-328 extended it to `ops:complete-backup` and `ops:complete-restore`, which is what
    // closes the shared-destination boundary the Phase 313-320 report left open.
    locks.lockDestination(resolved.destinationDir);

    let journal: SafetySetJournal;
    if (mode.kind === 'run') {
      const replanned = planSafetySetLifecycle(resolved, policy, now());
      if (replanned.digest !== mode.confirm) {
        throw new MaintenanceRefused(
          'this operation is not the one the plan was read against. Nothing was removed. A claim or a backup '
          + 'set has been created, removed or changed since then; or the policy flags are not the ones that '
          + 'were planned; or enough TIME has passed that a claim has crossed --min-age-days, which is a '
          + 'different decision about a different set of claims and is refused for the same reason as any '
          + 'other. Run --plan again and read the new list.');
      }
      const suffix = (deps.suffix ?? stagingSuffix)();
      if (!SAFETY_SUFFIX_RE.test(suffix)) {
        throw new MaintenanceRefused('the safety-set lifecycle run suffix is not one this command produces');
      }
      journal = {
        journal: 'catalog-authority.safety-set-lifecycle',
        version: SAFETY_SET_JOURNAL_VERSION,
        planDigest: replanned.digest,
        destination: resolved.destinationRelative,
        suffix,
        policy: replanned.policy,
        evaluatedAt: replanned.evaluatedAt,
        claims: replanned.claims,
        destinationSets: replanned.destination,
        decisions: replanned.decisions,
        removals: replanned.removals,
        protectedNewestRestorable: replanned.protectedNewestRestorable,
        protectedNewestRollbackPoint: replanned.protectedNewestRollbackPoint,
        restorableRemaining: replanned.restorableRemaining,
        restorableTopLevel: replanned.restorableTopLevel,
        entries: replanned.removals.map((name) =>
          ({ name, state: 'pending' as const, reason: null, consumeNonce: null })),
        phase: 'removing',
      };
      writeJournal(resolved.projectRoot, journal);
      at('after-journal', '');
    } else {
      journal = existing!;
    }

    return executeSafetySet(resolved, journal, at, writeJournal, clearJournal, remove);
  } finally {
    // INNERMOST FIRST, and every path out runs this. The order is the stack's, not this call site's.
    locks.release();
  }
}

/**
 * Count, FROM LIVE DISK, how many sets this build could restore from this destination right now.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHY A LIVE RECOUNT EXISTS AT ALL, GIVEN THE PLAN ALREADY COUNTED.
 * -----------------------------------------------------------------------------------------------------
 *
 * The plan's count came from the inventory the digest binds, and a `--confirm` re-proves that under the lock.
 * A `--resume` does not: it continues the operation the journal recorded, and between the crash and the
 * resume anything can have happened to the destination — most obviously an `ops:backup-retention --confirm`,
 * which holds the same destination lock this run is holding NOW but was not holding THEN, and which can
 * legitimately have removed ordinary sets the floor was counted over.
 *
 * So the floor is proved again from what is actually on disk, immediately before the first irreversible act
 * and after the reversible phase has completed. If it does not hold, every claim is still in the quarantine
 * directory, whole, and `--abandon` puts all of them back.
 */
export function proveFloorFromDisk(destinationDir: string): { readonly topLevel: number; readonly claims: number } {
  const destination = inventoryDestination(destinationDir);
  const topLevel = destination.filter((entry) => entry.setClass === 'VERIFIED' && entry.restorable).length;
  const claims = inventoryClaims(destinationDir)
    .filter((claim) => claim.claimClass === 'OWNED_SET' && claim.restorable).length;
  return { topLevel, claims };
}

function executeSafetySet(
  resolved: ResolvedSafetySet,
  start: SafetySetJournal,
  at: (point: SafetyFailpoint, name: string) => void,
  writeJournal: (projectRoot: string, journal: SafetySetJournal) => void,
  clearJournal: (projectRoot: string) => void,
  remove: (path: string, what: string, maxEntries: number) => number,
): SafetySetRunReport {
  let journal = start;
  const quarantine = safetyQuarantineDirName(journal.suffix);
  const quarantineDir = join(resolved.destinationDir, quarantine);
  const commitments = new Map(commitmentsOf(journal).map((commitment) => [commitment.name, commitment]));
  const byName = new Map(journal.claims.map((claim) => [claim.name, claim]));
  const notes: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  const removed: string[] = [];
  let bytesRemoved = 0;
  let stopped = false;
  let haltedBeforeDeleting: string | null = null;
  let restorableProvenBeforeDeleting: number | null = null;

  // HAS THIS OPERATION ALREADY MOVED OR REMOVED ANYTHING? Seeded from the journal and the filesystem, because
  // what matters to a reader is what the OPERATION has done and not which process did it.
  let effected = journal.entries.some((entry) => entry.state !== 'pending') || existsSync(quarantineDir);

  /**
   * Persist a state change, and only then believe it.
   *
   * THE DEFECT THIS CLOSES. The in-memory journal used to be mutated BEFORE the write was attempted, so a
   * write that threw left this process believing a state the disk did not record. Every later decision in
   * the same run — and every field of the report built on the way out — was then made against a document
   * that does not exist. The write is the state; nothing here is true until it lands.
   */
  const mark = (
    name: string,
    state: SafetyEntryState,
    reason: string | null,
    consumeNonce: string | null = null,
  ): void => {
    const next: SafetySetJournal = {
      ...journal,
      entries: journal.entries.map((entry) =>
        (entry.name === name ? { name, state, reason, consumeNonce } : entry)),
    };
    writeJournal(resolved.projectRoot, next);
    journal = next;
  };

  /**
   * Record the failure, and STOP. Nothing after an impossible state is destroyed.
   *
   * A FAILURE NEVER MOVES AN ENTRY OUT OF `deleting`. After the first `unlink` the tree may be partial, and
   * `deleting` is the only state that authorises finishing it; rewriting it to `failed` would strand the
   * operation, because a resume would then try to prove a half-deleted tree against a commitment it can
   * never satisfy, and an abandon will not put a truncated tree back either. The reason travels in the
   * report, which is where an operator reads it.
   */
  const stop = (name: string, reason: string): void => {
    if (stateOf(name) !== 'deleting') mark(name, 'failed', reason);
    failed.push({ name, reason });
    stopped = true;
  };

  try {
    const impossible = sweepPreconditions();
    if (impossible !== null) {
      stop(impossible.name, impossible.reason);
      return finishStopped();
    }
    return performRemovals();
  } catch (err) {
    if (!effected) throw err;
    throw new SafetySetFailed(
      `${safeReason(err)} `
      + '\nThis failure arrived AFTER this operation had already started moving restore claims. Read the '
      + 'report above: it names what is gone, what is still in the quarantine directory, and what that '
      + 'directory holds. The journal was kept. Continue with --resume or put back what is left with --abandon.',
      buildReport('INCOMPLETE', false, false));
  }

  /** Cross-validate every entry's recorded state against what the filesystem actually holds. */
  function sweepPreconditions(): { readonly name: string; readonly reason: string } | null {
    for (const entry of journal.entries) {
      const inDestination = existsSync(join(resolved.destinationDir, entry.name));
      const inQuarantine = existsSync(quarantineDir) && existsSync(join(quarantineDir, entry.name));
      const refusal = safetyPreconditionRefusal(entry.state, inDestination, inQuarantine);
      if (refusal !== null) return { name: entry.name, reason: refusal };
    }
    return null;
  }

  /** The report for a run that stopped before it did anything of its own. */
  function finishStopped(): SafetySetRunReport {
    for (const entry of journal.entries) {
      if (entry.state !== 'removed') continue;
      removed.push(entry.name);
      bytesRemoved += byName.get(entry.name)?.bytes ?? 0;
    }
    notes.push('This run STOPPED at a state one run cannot produce, before it moved or removed anything of '
      + 'its own. Everything still listed as untouched is exactly where it was, and everything already set '
      + 'aside can still be put back with --abandon.');
    notes.push('The journal was kept: a partial run is a state that must stay visible.');
    notes.push('Nothing was downloaded, fetched, played or acquired, and no command of any kind was issued: '
      + 'this run was filesystem work under a lock.');
    return buildReport('INCOMPLETE', false, false);
  }

  function performRemovals(): SafetySetRunReport {
    // 5. QUARANTINE. A rename inside the destination is same-filesystem and atomic: a claim name is observed
    // holding a whole claim, or nothing. Nothing is destroyed in this phase and all of it is reversible.
    for (const entry of journal.entries) {
      if (stopped) break;
      const current = stateOf(entry.name);
      if (current === 'removed' || current === 'quarantined' || current === 'deleting') continue;
      const source = join(resolved.destinationDir, entry.name);
      const target = join(quarantineDir, entry.name);
      const inDestination = existsSync(source);
      const inQuarantine = existsSync(quarantineDir) && existsSync(target);
      if (inDestination && inQuarantine) {
        stop(entry.name, 'this claim is present both in the destination and in the quarantine directory, which '
          + 'one run cannot produce. Nothing was removed for it, and nothing after it was touched.');
        continue;
      }
      if (!inDestination && inQuarantine) {
        // An interrupted rename: the effect landed and the record did not. The tree is adopted only after it
        // has been proved to be the claim this operation planned.
        try {
          const owned = requireSafetyQuarantine(resolved.destinationDir, journal, at);
          proveClaimIsPlanned(join(owned, entry.name), commitments.get(entry.name)!);
        } catch (err) {
          stop(entry.name, safeReason(err));
          continue;
        }
        effected = true;
        mark(entry.name, 'quarantined', null);
        notes.push(`${entry.name} was already in the quarantine directory: an interrupted rename, proved to be `
          + 'the claim that was planned, and adopted rather than repeated.');
        continue;
      }
      if (!inDestination && !inQuarantine) {
        stop(entry.name, 'this claim is in neither the destination nor the quarantine directory. Something '
          + 'removed it outside this command, and this run will not report having removed it.');
        continue;
      }
      try {
        // PROVED BEFORE IT IS MOVED, NOT ONLY BEFORE IT IS DELETED. A rename is reversible and it is still an
        // effect on a directory in somebody's backup folder — and a journal whose claim row FABRICATES an
        // ownership marker for a stranger's directory passes every document-level check, so without this it
        // would have this command pick that directory up and carry it into a quarantine tree.
        proveClaimIsPlanned(source, commitments.get(entry.name)!);
        requireSafetyQuarantine(resolved.destinationDir, journal, at);
        effected = true;
        renameSync(source, target);
      } catch (err) {
        stop(entry.name, err instanceof MaintenanceRefused ? err.message
          : 'this claim could not be renamed aside, so it was left exactly where it is');
        continue;
      }
      at('after-quarantine-rename', entry.name);
      mark(entry.name, 'quarantined', null);
      at('after-quarantine-mark', entry.name);
    }

    // 6. THE FLOOR, PROVED FROM LIVE DISK, IMMEDIATELY BEFORE THE FIRST IRREVERSIBLE ACT.
    const stillToDelete = journal.entries.some((entry) => {
      const state = stateOf(entry.name);
      return state === 'quarantined' || state === 'deleting';
    });
    if (!stopped && stillToDelete) {
      const live = proveFloorFromDisk(resolved.destinationDir);
      restorableProvenBeforeDeleting = live.topLevel + live.claims;
      if (restorableProvenBeforeDeleting < journal.policy.keepMinimumRestorable) {
        haltedBeforeDeleting =
          `this destination can now be restored from ${restorableProvenBeforeDeleting} set(s) and `
          + `--keep-minimum-restorable is ${journal.policy.keepMinimumRestorable}. Something changed what this `
          + 'destination holds since the plan was made — a set removed, a set that stopped verifying, or a '
          + 'prune that ran in between. NOTHING WAS DELETED: every claim this run set aside is whole in the '
          + 'quarantine directory, and --abandon puts all of them back.';
        stopped = true;
      }
      at('after-floor-proof', '');
    }

    // 7. DELETE, oldest first, each proved to be the planned claim and each bounded by what its own manifest
    // declared it to be. `removed` and `bytesRemoved` are about the OPERATION, not about this process.
    const recordRemoved = (name: string): void => {
      removed.push(name);
      bytesRemoved += byName.get(name)?.bytes ?? 0;
    };
    for (const entry of journal.entries) {
      const current = stateOf(entry.name);
      if (current === 'removed') { recordRemoved(entry.name); continue; }
      if (stopped) continue;
      if (current !== 'quarantined' && current !== 'deleting') continue;
      const target = join(quarantineDir, entry.name);
      const present = existsSync(target);

      if (current === 'quarantined' && !present) {
        stop(entry.name, 'this claim was recorded as set aside and is no longer in the quarantine directory. '
          + 'Nothing this command does removes a claim without recording that it was about to, so something '
          + 'else did. Nothing after it was touched.');
        continue;
      }
      if (current === 'deleting' && !present) {
        // The removal landed and the record did not. Idempotent by construction.
        mark(entry.name, 'removed', null);
        effected = true;
        recordRemoved(entry.name);
        continue;
      }

      let owned: string;
      try {
        owned = requireSafetyQuarantine(resolved.destinationDir, journal, at);
      } catch (err) {
        stop(entry.name, safeReason(err));
        continue;
      }
      const commitment = commitments.get(entry.name)!;
      const claimDir = join(owned, entry.name);
      if (current === 'quarantined') {
        // AN INTACT, NOT-YET-CONSUMED TREE IS PROVED AGAINST WHAT WAS PLANNED, EVERY TIME, IMMEDIATELY BEFORE
        // IT IS DESTROYED.
        try {
          proveClaimIsPlanned(claimDir, commitment);
        } catch (err) {
          stop(entry.name, safeReason(err));
          continue;
        }
        // THE NONCE IS PERSISTED BEFORE THE MARKER IS WRITTEN, and the marker before the first `unlink`.
        // That ordering is what makes "marker absent" mean "nothing has been unlinked yet" — a marker
        // written before the journal recorded the nonce would be an authority nothing could check.
        try {
          mark(entry.name, 'deleting', null, randomBytes(12).toString('hex'));
        } catch (err) {
          stop(entry.name, safeReason(err));
          continue;
        }
        at('after-deleting-mark', entry.name);
      }

      // ---- LIVE OWNERSHIP OF THE CHILD ABOUT TO BE CONSUMED --------------------------------------------
      //
      // THE DEFECT THIS CLOSES. This used to remove whatever directory occupied the planned child name, on
      // the strength of the OUTER quarantine marker and this entry's own record. The outer marker proves the
      // container and carries a list of NAMES; a name is not a tree. Anything moved to that name after
      // `deleting` was persisted — a stranger's directory, a restore's fresh claim, an operator's folder —
      // was recursively deleted.
      //
      // The consumption marker inside the child is the authority now, and the invariant it maintains is that
      // the first `unlink` is always preceded by it. So absence is not ambiguity: it means nothing has been
      // unlinked, and the tree must therefore still prove to be the planned claim exactly as an intact one
      // does. A replacement fails that, and a legitimately partial tree never reaches it.
      const consumeNonce = stateEntry(entry.name).consumeNonce;
      if (consumeNonce === null) {
        stop(entry.name, 'this claim is recorded as being removed and carries no consumption nonce, which '
          + 'one run cannot produce. Nothing was removed for it, and nothing after it was touched.');
        continue;
      }
      if (consumingMarkerPresent(claimDir)) {
        const proof = readConsumingMarker(claimDir, journal, commitment, consumeNonce);
        if (!proof.ok) {
          stop(entry.name, `${proof.why}. Nothing was removed for it, and nothing after it was touched.`);
          continue;
        }
      } else if (isEmptyDirectory(claimDir)) {
        // THE TAIL OF A CONSUMPTION, and the one place the marker's absence is not a question.
        //
        // The consumption marker is unlinked immediately before the directory itself, so a removal that got
        // everything out and then could not `rmdir` — a handle held open, a scanner, a permission that moved
        // — leaves an EMPTY directory with no authority in it. Requiring the marker here would strand the
        // operation: a resume could not prove an empty directory is the planned claim, and an abandon will
        // not put an empty tree back under a trusted name either.
        //
        // It is safe because an empty directory holds nothing that can be lost, and this one is inside a
        // quarantine directory this operation has already proved is its own. Nothing is read, followed or
        // recursed: the next step removes exactly one empty directory.
        notes.push(`${entry.name} was already emptied by an interrupted removal and only its directory was `
          + 'left. Nothing was in it.');
      } else {
        // NOTHING HAS BEEN UNLINKED, so this tree has to be the whole planned claim. A replacement put here
        // after the record was persisted dies exactly here, before a single entry of it is removed.
        try {
          proveClaimIsPlanned(claimDir, commitment);
        } catch (err) {
          stop(entry.name, `${safeReason(err)} This claim is recorded as being removed and carries no `
            + 'consumption marker, so nothing of it had been removed yet and what is there now is not what '
            + 'was planned. Nothing after it was touched.');
          continue;
        }
        try {
          writeConsumingMarker(claimDir, journal, commitment, consumeNonce);
        } catch (err) {
          stop(entry.name, safeReason(err));
          continue;
        }
        at('after-consuming-marker', entry.name);
      }

      try {
        effected = true;
        // THE BOUND COMES FROM WHAT THE CLAIM DECLARED ITSELF TO BE. A tree holding substantially more than
        // the manifest recorded is not the tree this command verified, and the walk refuses rather than
        // carrying on into somebody's data. The consumption marker goes last, so a kill anywhere inside this
        // leaves a tree that can still prove whose consumption it is.
        removeConsumedClaim(claimDir, commitment, remove);
      } catch (err) {
        stop(entry.name, err instanceof MaintenanceRefused ? err.message
          : 'this claim could not be removed from the quarantine directory');
        continue;
      }
      at('after-remove', entry.name);
      // THE TREE IS GONE, AND THE REPORT SAYS SO BEFORE ANYTHING ELSE IS ATTEMPTED.
      //
      // THE DEFECT THIS CLOSES. The state publication came first, and a journal write that failed here threw
      // out of the run before the claim was ever added to `removed` — so the post-effect report an operator
      // reads said NOTHING WAS REMOVED about a claim that no longer exists. What is on disk is not in doubt
      // at this point; only the record of it is. The durable state stays `deleting`, which is what lets a
      // resume close it out, and the report is truthful either way.
      recordRemoved(entry.name);
      mark(entry.name, 'removed', null);
    }

    // 8. THE PROOF. The safety set this run promised to protect is verified again, FROM DISK, after every
    // removal. A run that removed four claims and can no longer verify the one it said it was keeping has not
    // succeeded, whatever it deleted.
    let protectedVerified = false;
    if (journal.protectedNewestRestorable !== null) {
      const claim = byName.get(journal.protectedNewestRestorable);
      const setName = claim?.setName ?? null;
      if (setName !== null) {
        try {
          const proof = verifyBackupSet(
            join(resolved.destinationDir, journal.protectedNewestRestorable, setName));
          protectedVerified = proof.ok && proof.restorableUnderThisBuild;
        } catch {
          protectedVerified = false;
        }
      }
    }

    const outstanding = journal.entries.filter((entry) => entry.state !== 'removed');
    const complete = !stopped && failed.length === 0 && outstanding.length === 0 && !quarantineSurvives();
    let journalCleared = false;
    if (complete) {
      clearJournal(resolved.projectRoot);
      journalCleared = true;
    } else {
      notes.push('The journal was kept: this run did not finish, and a partial run is a state that must stay '
        + 'visible. Continue it with --resume, or put the quarantined claims back with --abandon.');
    }
    if (haltedBeforeDeleting !== null) {
      notes.push('This run stopped BEFORE ITS FIRST DELETION, on the live recount of what this destination '
        + 'could still be restored from. Nothing was destroyed and every claim it set aside is whole.');
    } else if (stopped) {
      notes.push('This run STOPPED at the first state one run cannot produce. Nothing after it was renamed or '
        + 'removed: everything still listed as untouched is exactly where it was, and everything already set '
        + 'aside can still be put back with --abandon.');
    }

    const state: SafetySetState = !complete ? 'INCOMPLETE'
      : protectedVerified || journal.protectedNewestRestorable === null ? 'REMOVED' : 'REMOVED_BUT_UNPROVEN';
    if (state === 'REMOVED_BUT_UNPROVEN') {
      notes.push('Every planned removal completed AND the safety set this run promised to keep could not be '
        + 'verified afterwards. Do not treat this destination as a recovery point until you have looked at it.');
    }
    notes.push('Nothing was downloaded, fetched, played or acquired, and no command of any kind was issued: '
      + 'this run was filesystem work under a lock.');
    return buildReport(state, state === 'REMOVED', journalCleared, protectedVerified);
  }

  function stateOf(name: string): SafetyEntryState {
    return stateEntry(name).state;
  }

  /** The journal's CURRENT record for a claim — the one on disk, because `mark` only believes what landed. */
  function stateEntry(name: string): SafetyJournalEntry {
    return journal.entries.find((entry) => entry.name === name)!;
  }

  /** Remove the quarantine directory when only its marker is left, and answer whether it is still there. */
  function quarantineSurvives(): boolean {
    return !tryRemoveOwnedQuarantine(quarantineDir, journal);
  }

  function buildReport(
    state: SafetySetState,
    ok: boolean,
    journalCleared: boolean,
    protectedVerified = false,
  ): SafetySetRunReport {
    let retained: SafetyRetainedArtifacts | null = null;
    if (quarantineSurvives()) retained = describeRetained(quarantineDir, quarantine);
    // CLAIMS KEPT COUNTS CLAIMS, NOT DIRECTORY ENTRIES. Counting every `keep` decision would fold a stray
    // file and a stranger's folder into a number labelled "kept", which is what somebody checks to see how
    // many safety sets they still have.
    const claimsKept = journal.decisions.filter((decision) => {
      if (decision.decision !== 'keep') return false;
      const claim = byName.get(decision.name);
      return claim !== undefined && claim.nonce !== null;
    }).length;
    const untouched = journal.entries
      .filter((entry) => entry.state === 'pending')
      .map((entry) => entry.name);
    return {
      report: SAFETY_SET_REPORT,
      version: SAFETY_SET_VERSION,
      ok,
      state,
      destinationName: resolved.destinationName,
      policy: journal.policy,
      planDigest: journal.planDigest,
      planned: journal.removals,
      removed,
      failed,
      untouched,
      claimsKept,
      protectedNewestRestorable: journal.protectedNewestRestorable,
      protectedNewestRestorableVerified: protectedVerified,
      protectedNewestRollbackPoint: journal.protectedNewestRollbackPoint,
      haltedBeforeDeleting,
      restorableProvenBeforeDeleting,
      bytesRemoved,
      retained,
      journalCleared,
      commands: 'none',
      network: 'none',
      notes,
    };
  }
}

/**
 * Remove a quarantine directory that holds nothing but this operation's own marker.
 *
 * Answers `true` when the predictable path is gone. It removes NOTHING unless the marker proves the directory
 * is this operation's, and the directory only when the marker is the last thing in it: a tree still holding a
 * claim is never removed as a container.
 */
function tryRemoveOwnedQuarantine(quarantineDir: string, journal: SafetySetJournal): boolean {
  if (!existsSync(quarantineDir)) return true;
  const proof = readSafetyQuarantineMarker(quarantineDir, journal);
  if (!proof.ok) return false;
  let leftovers: readonly string[];
  try {
    leftovers = readdirSync(quarantineDir).slice().sort();
  } catch {
    return false;
  }
  if (leftovers.some((entry) => entry !== SAFETY_QUARANTINE_MARKER_NAME)) return false;
  try {
    unlinkSync(safetyQuarantineMarkerPath(quarantineDir));
    rmdirSync(quarantineDir);
  } catch {
    return false;
  }
  return !existsSync(quarantineDir);
}

function describeRetained(quarantineDir: string, quarantine: string): SafetyRetainedArtifacts {
  let holds: readonly string[] = [];
  try {
    holds = readdirSync(quarantineDir).slice().sort()
      .filter((entry) => entry !== SAFETY_QUARANTINE_MARKER_NAME);
  } catch { /* named below regardless */ }
  return {
    quarantine,
    holds,
    warning: 'this directory holds complete backup sets, which means a copy of every secret file and the '
      + 'custodian keystore of the moments they were taken. Nothing else will mention it.',
  };
}

/**
 * A failure's own words, but ONLY when this product wrote them.
 *
 * An unexpected error here is the runtime's, whose message routinely carries the absolute path it failed on,
 * and a report is the thing an operator pastes into an issue.
 */
function safeReason(err: unknown): string {
  if (err instanceof MaintenanceRefused) return err.message;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const named = typeof code === 'string' && /^[A-Z]{1,16}$/.test(code) ? ` (${code})` : '';
  return `this safety-set lifecycle run failed for a reason it does not have safe wording for${named}.`;
}

// -----------------------------------------------------------------------------------------------------------
// Phase 318 — abandon
// -----------------------------------------------------------------------------------------------------------

export type SafetyAbandonState = 'ABANDONED' | 'ABANDONED_WITH_LOSS' | 'PARTIAL';

export interface SafetySetAbandonReport {
  readonly report: typeof SAFETY_SET_REPORT;
  readonly version: typeof SAFETY_SET_VERSION;
  /** True ONLY for a clean unwind: everything put back, nothing gone, nothing retained. */
  readonly ok: boolean;
  readonly state: SafetyAbandonState;
  readonly destinationName: string;
  readonly planDigest: string;
  readonly putBack: readonly string[];
  /** Claims this abandon cannot bring back, because they were already deleted. Named, always. */
  readonly goneForever: readonly string[];
  readonly unresolved: readonly string[];
  readonly retained: SafetyRetainedArtifacts | null;
  readonly journalCleared: boolean;
  readonly commands: 'none';
  readonly network: 'none';
  readonly notes: readonly string[];
}

/**
 * Put back every claim this operation quarantined and has not yet deleted.
 *
 * IT TAKES ONLY THE PROJECT ROOT. The destination, the suffix and the names come from the journal the
 * interrupted run wrote — not from flags typed now, which can differ from the run that actually renamed those
 * directories.
 *
 * AN ABANDON THAT LOST A CLAIM IS NOT A SUCCESS, AND SAYS SO. `ok` is a clean unwind and nothing else;
 * `ABANDONED_WITH_LOSS` is its own state and the CLI exits non-zero for it.
 */
export function abandonSafetySetLifecycle(
  projectRoot: string,
  deps: SafetySetDeps = {},
): SafetySetAbandonReport {
  const at = deps.at ?? (() => { /* production does nothing here */ });
  const writeJournal = deps.journalWriter ?? writeSafetySetJournal;
  const clearJournal = deps.journalClearer ?? clearSafetySetJournal;
  const root = resolveMaintenanceRoot(projectRoot, 'project directory');
  // ---- A PROJECT PART WAY THROUGH A RESTORE REFUSES THIS COMMAND ENTIRELY, ABANDON INCLUDED --------
  //
  // THE DEFECT THIS CLOSES. The contract this command states — in its usage, its note and its design — is
  // that a project mid-restore refuses it. `--abandon` did not take that check, so an abandon could run
  // beside a live restore and rename claim directories back into the destination that restore is publishing
  // into. The deliberate exception is for an interrupted PRUNE, and only that: two commands that can each
  // only be unwound after the other is a wedge with no way out, and retention never descends into a claim
  // namespace, so an interrupted prune cannot make this recovery wrong. A live restore can.
  //
  // Checked here, BEFORE the lock and before `phase: 'abandoning'` is written, and again under the lock —
  // because a check made before a lock is a check about a moment that has passed.
  assertNoRestoreInProgress(root);

  const locks = MaintenanceLocks.open(root);
  try {
    assertNoRestoreInProgress(root);
    const opening = readSafetySetJournal(root);
    if (opening === null) {
      throw new MaintenanceRefused('there is no interrupted safety-set lifecycle run in this project to abandon');
    }
    const resolved = resolveSafetySetDestination(root, opening.destination);
    const destinationDir = resolved.destinationDir;
    const destinationName = resolved.destinationName;
    locks.lockDestination(resolved.destinationDir);

    let current: SafetySetJournal = { ...opening, phase: 'abandoning' };
    const quarantine = safetyQuarantineDirName(current.suffix);
    const quarantineDir = join(destinationDir, quarantine);
    const commitments = new Map(commitmentsOf(current).map((commitment) => [commitment.name, commitment]));
    const putBack: string[] = [];
    const goneForever: string[] = [];
    const unresolved: string[] = [];
    const notes: string[] = [];
    // AN ABANDON OF AN OPERATION THAT MOVED THINGS IS ALWAYS POST-EFFECT.
    let effected = current.entries.some((entry) => entry.state !== 'pending') || existsSync(quarantineDir);

    const finish = (): SafetySetAbandonReport => {
      const retained = tryRemoveOwnedQuarantine(quarantineDir, current)
        ? null : describeRetained(quarantineDir, quarantine);
      const clearable = unresolved.length === 0 && retained === null;
      let journalCleared = false;
      if (clearable) {
        clearJournal(root);
        journalCleared = true;
      } else {
        notes.push('The journal was kept, because this abandon did not put everything back.');
      }
      if (goneForever.length > 0) {
        notes.push('These claims had already been deleted and a rename cannot bring them back. If one of them '
          + 'held the safety set you needed, the recovery is another backup, not this command. This is NOT a '
          + 'clean unwind and this command does not report it as one.');
      }
      notes.push('An abandon puts directories back. It restores no database and no keystore, because it never '
        + 'touched either: this command only ever moved and removed directories in a backup destination.');
      notes.push('No command of any kind was issued.');
      const state: SafetyAbandonState = unresolved.length > 0 || retained !== null ? 'PARTIAL'
        : goneForever.length > 0 ? 'ABANDONED_WITH_LOSS' : 'ABANDONED';
      return {
        report: SAFETY_SET_REPORT,
        version: SAFETY_SET_VERSION,
        ok: state === 'ABANDONED',
        state,
        destinationName,
        planDigest: current.planDigest,
        putBack,
        goneForever,
        unresolved,
        retained,
        journalCleared,
        commands: 'none',
        network: 'none',
        notes,
      };
    };

    try {
      writeJournal(root, current);

      for (const entry of current.entries) {
        if (entry.state === 'removed') {
          goneForever.push(entry.name);
          // THE CLAIM IS GONE AND ITS NAME MAY NOT BE FREE. A later restore draws its own nonce, so a
          // collision is astronomically unlikely — and "gone forever" beside a directory that is plainly
          // there still deserves the sentence that reconciles the two. Nothing is touched either way.
          if (existsSync(join(destinationDir, entry.name))) {
            notes.push(`${entry.name} was destroyed by this operation and something is at its name again. `
              + 'That is not the claim this operation removed, and nothing here touched it.');
          }
          continue;
        }
        const source = join(quarantineDir, entry.name);
        const target = join(destinationDir, entry.name);
        const inQuarantine = existsSync(quarantineDir) && existsSync(source);
        // PRESENCE OF THE NAME, not readability of what it resolves to: a dangling link at a claim's name
        // still occupies it, and renaming onto it would be renaming onto something.
        const targetTaken = lstatSync(target, { throwIfNoEntry: false }) !== undefined;

        // ---- `deleting` IS ANSWERED FIRST, BECAUSE ONLY IT KNOWS WHAT AN ABSENCE MEANS ----------------
        //
        // THE DEFECT THIS CLOSES. The target-present branch came first and read as "never quarantined, or
        // already put back by an interrupted abandon" — a sentence that is FALSE for a `deleting` entry. A
        // `deleting` entry was definitely quarantined, and its tree may already have been destroyed; so an
        // unrelated directory that had since taken its name was being read as a clean put-back. The entry
        // was marked `pending`, counted as neither put back nor lost, and an abandon that had lost a safety
        // set could render `RESULT: ABANDONED` and exit zero.
        if (entry.state === 'deleting') {
          if (inQuarantine) {
            // A tree that was being consumed may be truncated. Putting a partial safety set back under a
            // name an operator trusts is the exact failure the quarantine exists to prevent.
            unresolved.push(entry.name);
            notes.push(`${entry.name} was part way through being removed and may be incomplete. It was NOT `
              + 'put back under its own name, because a partial safety set under a trusted name is worse '
              + 'than none.');
            continue;
          }
          // GONE. This operation was consuming that tree and it is not there any more: the removal landed
          // and the record did not. Whatever is at its old name now is not it.
          goneForever.push(entry.name);
          current = markEntry(current, entry.name, 'removed', null);
          writeJournal(root, current);
          if (targetTaken) {
            notes.push(`${entry.name} was part way through being removed and is gone. Something is at its `
              + 'name again: that is NOT the claim this operation destroyed, this command did not put it '
              + 'there, and nothing here touched it.');
          }
          continue;
        }

        if (!inQuarantine) {
          if (targetTaken) {
            // ---- AN INTERRUPTED ABANDON RENAME, DISTINGUISHED WHERE THE DISTINCTION EXISTS ------------
            //
            // `quarantined` and something at its own name is the one case where the two readings can be
            // told apart: a previous abandon really did rename it back and die before recording it, OR
            // something unrelated took the name. Proving it against the commitment answers which, so a
            // genuine put-back is REPORTED as one and a replacement is named and left alone — rather than
            // both being silently marked `pending` and counted as neither.
            if (entry.state === 'quarantined') {
              try {
                proveClaimIsPlanned(target, commitments.get(entry.name)!);
              } catch {
                unresolved.push(entry.name);
                notes.push(`${entry.name} was recorded as set aside, and what is at its name now is not it. `
                  + 'Nothing here touched either.');
                continue;
              }
              putBack.push(entry.name);
              current = markEntry(current, entry.name, 'pending', null);
              writeJournal(root, current);
              continue;
            }
            // `pending` or `failed`: this operation never moved it, so it is where it has always been.
            current = markEntry(current, entry.name, 'pending', null);
            writeJournal(root, current);
            continue;
          }
          // IN NEITHER PLACE, recorded `pending`, `quarantined` or `failed`: this operation never began
          // removing it, so its absence was not caused here. That is a question, not a conclusion.
          unresolved.push(entry.name);
          continue;
        }
        if (targetTaken) {
          unresolved.push(entry.name);
          continue;
        }
        // THE SAME OWNERSHIP AND IDENTITY PROOFS AS A DELETE. Renaming a stranger's directory INTO an
        // operator's backup destination, under a claim name, is its own kind of damage.
        try {
          requireSafetyQuarantine(destinationDir, current, at);
          proveClaimIsPlanned(source, commitments.get(entry.name)!);
        } catch {
          unresolved.push(entry.name);
          continue;
        }
        try {
          effected = true;
          renameSync(source, target);
        } catch {
          unresolved.push(entry.name);
          continue;
        }
        at('after-abandon-rename', entry.name);
        // RECORDED IN THE REPORT BEFORE IT IS RECORDED IN THE JOURNAL. The rename has landed; if the write
        // below is what fails, the claim IS back under its own name.
        putBack.push(entry.name);
        current = markEntry(current, entry.name, 'pending', null);
        writeJournal(root, current);
      }

      return finish();
    } catch (err) {
      if (!effected) throw err;
      throw new SafetySetAbandonFailed(
        `${safeReason(err)} `
        + '\nThis failure arrived AFTER this abandon had already moved a restore claim. Read the report above: '
        + 'it names what was put back, what is gone for good, what is still out of place and what the retained '
        + 'directory holds.',
        finishAfterFailure());
    }

    function finishAfterFailure(): SafetySetAbandonReport {
      const retained = existsSync(quarantineDir) ? describeRetained(quarantineDir, quarantine) : null;
      return {
        report: SAFETY_SET_REPORT,
        version: SAFETY_SET_VERSION,
        ok: false,
        state: 'PARTIAL',
        destinationName,
        planDigest: current.planDigest,
        putBack,
        goneForever,
        unresolved: [...unresolved, ...current.entries
          .filter((entry) => entry.state !== 'removed' && !putBack.includes(entry.name)
            && !unresolved.includes(entry.name) && !goneForever.includes(entry.name))
          .map((entry) => entry.name)],
        retained,
        journalCleared: false,
        commands: 'none',
        network: 'none',
        notes: [...notes, 'The journal was kept. Run --abandon again once you have dealt with what stopped it.'],
      };
    }
  } finally {
    locks.release();
  }
}

function markEntry(
  journal: SafetySetJournal,
  name: string,
  state: SafetyEntryState,
  reason: string | null,
): SafetySetJournal {
  return {
    ...journal,
    // AN ABANDON NEVER LEAVES AN ENTRY IN `deleting`, so it never writes a consumption nonce: it either puts
    // a whole tree back (`pending`), records one as gone (`removed`), or leaves it exactly as it found it.
    entries: journal.entries.map((entry) =>
      (entry.name === name ? { name, state, reason, consumeNonce: null } : entry)),
  };
}

// -----------------------------------------------------------------------------------------------------------
// Rendering. Claim names, classes, evidence, dates, sizes, counts and closed reasons. Never a path.
// -----------------------------------------------------------------------------------------------------------

const CLAIM_LABEL: Readonly<Record<ClaimClass, string>> = Object.freeze({
  OWNED_SET: 'safety set, verified',
  OWNED_UNVERIFIED: 'safety set, DOES NOT VERIFY',
  OWNED_EMPTY: 'empty claim',
  OWNED_IN_FLIGHT: 'claim with work in flight',
  OWNED_UNEXPECTED: 'claim holding something unexpected',
  OTHER_BUILD: 'claim of another build',
  MALFORMED: 'not provably ours',
  UNREADABLE: 'unreadable',
  NOT_A_DIRECTORY: 'not a directory',
});

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function renderSafetySetPlan(plan: SafetySetPlan): string {
  const lines: string[] = [];
  lines.push(`Restore safety-set lifecycle plan — ${plan.destinationName}`);
  lines.push(`  policy              keep-last ${plan.policy.keepLast}, min-age-days ${plan.policy.minAgeDays}, `
    + `include-unverified ${plan.policy.includeUnverified}, include-empty-claims ${plan.policy.includeEmptyClaims}, `
    + `keep-minimum-restorable ${plan.policy.keepMinimumRestorable}`);
  lines.push('');
  const reasons = new Map(plan.decisions.map((decision) => [decision.name, decision]));
  lines.push('  the restore claims in this destination:');
  if (plan.claims.length === 0) lines.push('    (none — no restore has taken a safety set into this destination)');
  for (const claim of plan.claims) {
    const decision = reasons.get(claim.name)!;
    const verb = decision.decision === 'remove' ? 'REMOVE' : 'keep  ';
    lines.push(`    ${verb}  ${claim.name}`);
    lines.push(`            ${CLAIM_LABEL[claim.claimClass]}`
      + `${claim.setName === null ? '' : `, holding ${claim.setName}`}`
      + `${claim.schemaVersion === null ? '' : `, schema ${claim.schemaVersion}`}`
      + `${claim.takenAt === null ? ', no manifest date' : `, taken ${claim.takenAt}`}`
      + `${claim.bytes === 0 ? '' : `, ${humanBytes(claim.bytes)}`}`);
    lines.push(`            evidence: ${claim.evidence} — ${CLAIM_EVIDENCE_TEXT[claim.evidence]}`);
    lines.push(`            ${decision.reason}: ${SAFETY_SET_REASON_TEXT[decision.reason]}`);
    if (claim.findings.length > 0) lines.push(`            findings: ${claim.findings.join(', ')}`);
  }
  lines.push('');
  lines.push('  the ordinary backup sets in this destination (this command never touches one):');
  const ordinary = plan.destination.filter((entry) => entry.setClass === 'VERIFIED'
    || entry.setClass === 'UNVERIFIED');
  if (ordinary.length === 0) lines.push('    (none)');
  for (const entry of ordinary) {
    lines.push(`    ${entry.setClass === 'VERIFIED' ? (entry.restorable ? 'restorable' : 'rollback   ') : 'unverified'}`
      + `  ${entry.name}${entry.takenAt === null ? '' : `, taken ${entry.takenAt}`}`);
  }
  lines.push('');
  lines.push(`  would remove        ${plan.removals.length === 0 ? 'nothing' : plan.removals.join(', ')}`);
  lines.push(`  freeing            ~${humanBytes(plan.bytesToRemove)} (what the manifests declare)`);
  lines.push(`  protected claim     ${plan.protectedNewestRestorable ?? 'none — this destination holds no restorable safety set'}`);
  lines.push(`  protected rollback  ${plan.protectedNewestRollbackPoint ?? '-'}`);
  lines.push(`  restorable left     ${plan.restorableRemaining} (of which ${plan.restorableTopLevel} are ordinary top-level sets)`);
  lines.push(`  wrote               ${plan.wrote}`);
  lines.push(`  commands issued     ${plan.commands}`);
  lines.push('');
  lines.push('  Removals happen OLDEST FIRST, and every claim is renamed into a private quarantine directory');
  lines.push('  before it is deleted, so a claim name in this destination always holds a whole claim or nothing.');
  lines.push('  The floor is proved again from what is on disk immediately before the first deletion.');
  lines.push('');
  lines.push(`  digest: ${plan.digest}`);
  lines.push('  Run it with --confirm <digest>. The digest covers this whole list — every claim, its ownership');
  lines.push('  marker, its safety set, its date and its decision, AND every ordinary set in this destination —');
  lines.push('  so a backup or a restore that happened since you read this will refuse it.');
  return lines.join('\n');
}

export function renderSafetySetRun(report: SafetySetRunReport): string {
  const lines: string[] = [];
  lines.push(`Restore safety-set lifecycle — ${report.state}`);
  lines.push(`  destination         ${report.destinationName}`);
  lines.push(`  planned             ${report.planned.length === 0 ? 'nothing' : report.planned.join(', ')}`);
  lines.push(`  removed             ${report.removed.length === 0 ? 'nothing' : report.removed.join(', ')}`);
  lines.push(`  freed              ~${humanBytes(report.bytesRemoved)}`);
  lines.push(`  claims kept         ${report.claimsKept}`);
  lines.push(`  protected claim     ${report.protectedNewestRestorable ?? '-'}`);
  lines.push(`  ...still verifies   ${report.protectedNewestRestorableVerified ? 'YES' : 'NO'}`);
  lines.push(`  protected rollback  ${report.protectedNewestRollbackPoint ?? '-'}`);
  lines.push(`  journal cleared     ${report.journalCleared}`);
  lines.push(`  commands issued     ${report.commands}`);
  if (report.haltedBeforeDeleting !== null) {
    lines.push('  HALTED BEFORE ANY DELETION:');
    lines.push(`    ${report.haltedBeforeDeleting}`);
  }
  if (report.failed.length > 0) {
    lines.push('  STOPPED AT:');
    for (const failure of report.failed) lines.push(`    ${failure.name} — ${failure.reason}`);
  }
  if (report.untouched.length > 0) {
    lines.push(`  NOT TOUCHED         ${report.untouched.join(', ')}`);
    lines.push('    these were planned for removal and are exactly where they were.');
  }
  if (report.retained !== null) {
    lines.push(`  RETAINED            ${report.retained.quarantine}`);
    lines.push(`    holds             ${report.retained.holds.length === 0 ? '(nothing listable)' : report.retained.holds.join(', ')}`);
    lines.push(`    ${report.retained.warning}`);
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${report.ok ? 'REMOVED' : report.state}`);
  return lines.join('\n');
}

export function renderSafetySetAbandon(report: SafetySetAbandonReport): string {
  const lines: string[] = [];
  lines.push(`Restore safety-set lifecycle abandoned — ${report.state}`);
  lines.push(`  destination         ${report.destinationName}`);
  lines.push(`  put back            ${report.putBack.length === 0 ? 'nothing had been quarantined yet' : report.putBack.join(', ')}`);
  lines.push(`  GONE FOREVER        ${report.goneForever.length === 0 ? 'nothing was deleted' : report.goneForever.join(', ')}`);
  if (report.unresolved.length > 0) lines.push(`  STILL OUT OF PLACE  ${report.unresolved.join(', ')}`);
  lines.push(`  journal cleared     ${report.journalCleared}`);
  if (report.retained !== null) {
    lines.push(`  RETAINED            ${report.retained.quarantine}`);
    lines.push(`    holds             ${report.retained.holds.length === 0 ? '(nothing listable)' : report.retained.holds.join(', ')}`);
    lines.push(`    ${report.retained.warning}`);
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${report.state}`);
  return lines.join('\n');
}

/** The default policy, exported so the CLI and the docs cannot disagree about it. */
export { DEFAULT_SAFETY_SET_POLICY };
