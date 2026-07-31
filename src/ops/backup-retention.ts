import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  BACKUP_MANIFEST_NAME,
  readBackupManifest,
  type BackupManifest,
} from './complete-backup.js';
import { verifyBackupSet } from './backup-set-verification.js';
import { RESTORE_JOURNAL_NAME } from './complete-restore.js';
import { manifestShape, proveBackupSetIdentity } from './maintenance-identity.js';
import {
  DESTINATION_LOCK_DIRNAMES,
  MAINTENANCE_NAME_RE,
  MaintenanceLocks,
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
import {
  DEFAULT_RETENTION_POLICY,
  MAX_KEEP_LAST,
  MAX_KEEP_MINIMUM,
  MAX_MIN_AGE_DAYS,
  REMOVABLE_CLASSES,
  RETENTION_REASONS,
  SET_CLASSES,
  assertUsablePolicy,
  evaluateRetention,
  instantOf,
  removalEntryBound,
  type InventoryEntry,
  type RetentionDecision,
  type RetentionPolicy,
  type SetClass,
} from './retention-model.js';

// Phases 305-312 — retention, the half of the backup lifecycle that only ever printed a plan.
//
// WHAT THIS PRODUCT DID BEFORE. It took backup sets on a schedule, took another one every time an operator
// restored, and removed none of them — with `deploy/unraid-catalog-maintenance.sh` printing a shell listing
// and the instruction to recursively delete one directory by hand. That instruction cannot tell a set that
// verifies from one truncated last Tuesday, cannot tell the ONLY set this build could restore from one of
// ten, cannot tell the pre-upgrade rollback point from a routine nightly, takes no lock, and — being a
// recursive delete — leaves HALF A SET UNDER A NAME AN OPERATOR TRUSTS if it is interrupted.
//
// IT ISSUES NO COMMAND AT ALL. No `docker`, no child process, no network, no registry, no media path, no
// media server. It is host-side filesystem work under a lock, which is why it can run while the stack is up
// and why its command ledger is empty — asserted, not promised.
//
// WHAT IT READS, EXACTLY. Deciding whether a set is good means hashing every byte of it, and one of its four
// components is the secrets directory — so this DOES open and read secret files, through descriptors, without
// following links, for the sole purpose of hashing. It never interprets, parses, prints, digests-into-a-report
// or otherwise surfaces a byte of them, it accepts no credential on a command line, and no path and no
// component content reaches any report. That is the boundary, and it is stated this way on purpose: a
// comfortable claim about not touching secret files at all would be a false one.
//
// NOTHING IS DELETED IN PLACE. Every set is RENAMED into a private quarantine directory in the same folder
// (therefore the same filesystem, therefore atomically) and only then removed. At every instant an observer
// can look, a set name in the destination holds a whole set or nothing at all.
//
// See `docs/PHASES_305_312_BACKUP_RETENTION.md` for the threat model, the protection boundary and the limits.

export const RETENTION_REPORT = 'phase-305-312-backup-retention';
export const RETENTION_VERSION = 1;

export const RETENTION_JOURNAL_NAME = '.catalog-retention.journal.json';

/**
 * Version 2. Version 1 is refused at the version boundary, before any later field is read.
 *
 * WHAT CHANGED, AND WHY IT COULD NOT BE A COMPATIBLE ADDITION. A version-1 journal recorded no evaluation
 * instant, so its decisions could not be RECOMPUTED — only re-hashed, which proves a document agrees with
 * itself and nothing about whether it describes a decision this program would ever make. It also had no
 * `deleting` state, so a resume could not tell an intact quarantined set from a partially consumed one. Both
 * are load-bearing for what a recovery is allowed to destroy, so an old document is refused rather than
 * upgraded: there is nothing correct to fill either field in with.
 */
export const RETENTION_JOURNAL_VERSION = 2;

/** The journal is bounded before it is parsed. A destination of 2000 entries fits inside this many times over. */
export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

/** How many entries this command will inventory. A backup destination larger than this is not one of ours. */
export const MAX_DESTINATION_ENTRIES = 2000;

/** The private directory sets are renamed into before they are removed. */
export const QUARANTINE_PREFIX = '.catalog-retention.removing-';

/** The unpredictable, secret-free name a quarantine directory is BUILT under before it is published. */
export const QUARANTINE_CLAIM_PREFIX = '.catalog-retention.claiming-';

/** The ownership marker inside a quarantine directory. Nothing is removed from a tree without one. */
export const QUARANTINE_MARKER_NAME = 'catalog-retention-quarantine.json';

// THE SECOND LOCK DOMAIN IS NO LONGER THIS COMMAND'S. It is `DESTINATION_LOCK_DIRNAME`, defined once in
// `maintenance-safety.ts` and taken by all four backup-family commands — see Phases 321-328. This module used
// to define it, under a name that said "retention", and that name became a lie the moment a second command
// took it. The names are still EXCLUDED FROM THE INVENTORY here, and that is load-bearing rather than
// cosmetic: `--plan` takes no lock, so the lock does not exist when the plan is read; `--confirm` takes it and
// then re-inventories under it, so a run that counted its own lock as destination content would produce a
// different inventory from the plan every single time, and no confirmation could ever succeed.

/** Exactly what `stagingSuffix()` produces. Validated wherever a suffix is concatenated into a path. */
export const RETENTION_SUFFIX_RE = /^[0-9a-f]{12}$/;

export function quarantineDirName(suffix: string): string {
  if (!RETENTION_SUFFIX_RE.test(suffix)) {
    throw new MaintenanceRefused('the retention run suffix is not one this command produces');
  }
  return `${QUARANTINE_PREFIX}${suffix}`;
}

// -----------------------------------------------------------------------------------------------------------
// The request, and what resolving it proves
// -----------------------------------------------------------------------------------------------------------

export interface RetentionRequest {
  /** The Compose project directory, absolute. */
  readonly projectRoot: string;
  /** Where sets are kept, relative to the project. */
  readonly destination: string;
}

export interface ResolvedRetention {
  readonly projectRoot: string;
  readonly destinationDir: string;
  /** Exactly what the operator wrote, relative to the project. This is what the journal records. */
  readonly destinationRelative: string;
  /** The destination's own leaf name. The only part of it that ever reaches a report. */
  readonly destinationName: string;
}

/**
 * Resolve a retention request, refusing everything it would refuse for real before anything is read.
 *
 * A RESTORE IN PROGRESS REFUSES THE WHOLE OPERATION. An installation half-way through `ops:complete-restore`
 * is the worst possible moment to be deleting the sets it might have to fall back to: the journal names the
 * set being restored AND the safety set that run took, and either may live in this destination. This command
 * does not attempt to reason about which — it stops, before the destination is even listed. The check is
 * `existsSync` rather than a parse, so a restore journal this build cannot read still refuses.
 */
export function resolveRetentionRequest(request: RetentionRequest): ResolvedRetention {
  const projectRoot = resolveRetentionProject(request.projectRoot);
  return resolveRetentionDestination(projectRoot, request.destination);
}

export function resolveRetentionProject(projectRoot: string): string {
  const root = resolveMaintenanceRoot(projectRoot, 'project directory');
  assertNoRestoreInProgress(root,
    'this project is part way through a restore — ops:complete-restore left its journal here. That run may be '
    + 'holding the set it is restoring and the safety set it took, both of which can be in this destination, '
    + 'so nothing here will remove anything. Finish it with --resume or unwind it with --abandon first.');
  return root;
}

export function assertNoRestoreInProgress(projectRoot: string, why: string): void {
  if (existsSync(join(projectRoot, RESTORE_JOURNAL_NAME))) throw new MaintenanceRefused(why);
}

/**
 * Resolve a destination named RELATIVE to the project.
 *
 * IT IS RELATIVE, AND THAT IS WHY THE JOURNAL CAN RECORD IT. A durable file in an operator's project
 * directory has no business carrying that operator's absolute appdata layout; the journal lives IN the
 * project root, so the project root is the one path a reader always already has, and everything else can be
 * expressed against it.
 */
export function resolveRetentionDestination(projectRoot: string, relative: string): ResolvedRetention {
  // ONE RESOLUTION, SHARED WITH THE OTHER THREE COMMANDS. Phases 321-328 moved it to `maintenance-safety.ts`
  // verbatim — containment, no symbolic link at any component, `realpath` so two spellings of one directory
  // are one directory, and the project-root refusal — because a lock is only exclusive between callers that
  // agree on which directory they are naming.
  return resolveBackupDestination(projectRoot, relative);
}

// -----------------------------------------------------------------------------------------------------------
// Phase 305 — the inventory
// -----------------------------------------------------------------------------------------------------------

/**
 * Classify every entry in a backup destination.
 *
 * TOTAL, AND ONLY TWO CLASSES ARE EVER REMOVABLE. A hand-made backup taken by following the documented
 * commands carries no manifest of ours, classifies `FOREIGN`, is reported so an operator can see it, and is
 * never touched: this command owns what it took.
 *
 * IT READS EVERY BYTE, INCLUDING THE SECRETS COMPONENT, AND SURFACES NONE OF IT. `verifyBackupSet` hashes
 * each component through a descriptor opened without following a link — which for the secrets component means
 * opening and reading secret files. Nothing here parses, prints or reports a byte of them; what leaves this
 * function is a class, a date, a schema version, a digest and two counts.
 */
export function inventoryDestination(destinationDir: string): readonly InventoryEntry[] {
  let names: readonly string[];
  try {
    names = readdirSync(destinationDir).slice().sort();
  } catch {
    throw new MaintenanceRefused('the backup destination could not be listed');
  }
  if (names.length > MAX_DESTINATION_ENTRIES) {
    throw new MaintenanceRefused(
      `this backup destination holds more than ${MAX_DESTINATION_ENTRIES} entries, which is more than this `
      + 'command will inventory. Point it at a destination this product manages.');
  }
  return names
    .filter((name) => !DESTINATION_LOCK_DIRNAMES.includes(name))
    .map((name) => classifyEntry(destinationDir, name));
}

export function classifyEntry(destinationDir: string, name: string): InventoryEntry {
  const empty = {
    name, takenAt: null, takenAtMs: null, schemaVersion: null, setDigest: '', restorable: false,
    bytes: 0, entries: 0, findings: [] as readonly string[],
  };
  // A DOT-PREFIXED NAME IS NEVER A SET. Every published set is created under `assertUsableName`, which cannot
  // produce a leading dot — so one rule covers a backup staging tree, a restore safety-set claim, a lock
  // directory, this command's own quarantine and anything a future namespace adds, without any of them having
  // to be enumerated here.
  if (name.startsWith('.')) return { ...empty, setClass: 'RESERVED' };
  // A NAME THIS COMMAND COULD NOT HAVE CREATED IS NOT THIS COMMAND'S TO REMOVE.
  if (!MAINTENANCE_NAME_RE.test(name)) return { ...empty, setClass: 'FOREIGN' };

  const path = join(destinationDir, name);
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return { ...empty, setClass: 'NOT_A_DIRECTORY' };
  }
  // `lstat`, SO A SYMBOLIC LINK IS SEEN AS A LINK. A backup set is never a link, and a link at a set's name
  // points at bytes this command did not verify.
  if (stats.isSymbolicLink() || !stats.isDirectory()) return { ...empty, setClass: 'NOT_A_DIRECTORY' };
  if (!existsSync(join(path, BACKUP_MANIFEST_NAME))) return { ...empty, setClass: 'FOREIGN' };

  let manifest: BackupManifest;
  try {
    manifest = readBackupManifest(path);
  } catch {
    return { ...empty, setClass: 'UNREADABLE' };
  }
  const shape = shapeOfManifest(name, manifest);

  let report;
  try {
    report = verifyBackupSet(path);
  } catch {
    // A SET THAT CANNOT BE EXAMINED IS NOT A SET THAT CAN BE REMOVED. Whatever stopped the verification —
    // a special file, a link inside it, a permission — is a question, and this command does not answer a
    // question by deleting the thing that asked it.
    return { ...shape, setClass: 'UNREADABLE', setDigest: '', restorable: false, findings: [] };
  }
  const findings = [...new Set(report.problems.map((problem) => problem.finding))].sort();
  return {
    ...shape,
    setClass: report.ok ? 'VERIFIED' : 'UNVERIFIED',
    setDigest: report.setDigest,
    restorable: report.restorableUnderThisBuild,
    findings,
  };
}

/**
 * What a manifest says about the shape of a set.
 *
 * MOVED TO `maintenance-identity.ts` IN PHASE 313 and imported back under its old name. A second command now
 * reasons about the same manifest fields for the same purpose, and two copies of "what a set declares itself
 * to be" is how the two would drift.
 */
const shapeOfManifest = manifestShape;

// -----------------------------------------------------------------------------------------------------------
// Phase 308 — the plan, and the digest that binds the list somebody read
// -----------------------------------------------------------------------------------------------------------

export interface RetentionPlan {
  readonly report: typeof RETENTION_REPORT;
  readonly version: typeof RETENTION_VERSION;
  readonly journalVersion: typeof RETENTION_JOURNAL_VERSION;
  readonly destinationName: string;
  readonly policy: RetentionPolicy;
  /**
   * The instant these decisions were evaluated at.
   *
   * IT IS IN THE PLAN AND IN THE JOURNAL, AND DELIBERATELY NOT IN THE DIGEST. The journal needs it so that a
   * recovery can RE-RUN the evaluation rather than re-hash it — a document that agrees with itself proves
   * nothing about whether it describes a decision this program would ever make. The digest must not carry it,
   * because a digest that moved every millisecond could never be typed back.
   */
  readonly evaluatedAt: string;
  readonly inventory: readonly InventoryEntry[];
  readonly decisions: readonly RetentionDecision[];
  /** Ordered OLDEST FIRST. This is the order the run performs, and the order a resume continues. */
  readonly removals: readonly string[];
  readonly protectedRestorable: string | null;
  readonly restorableRemaining: number;
  readonly bytesToRemove: number;
  readonly digest: string;
  readonly wrote: 'nothing';
  readonly network: 'none';
  readonly commands: 'none';
}

/**
 * The canonical identity of one retention operation.
 *
 * IT BINDS THE INVENTORY, not only the policy and the names. A set published into the destination between the
 * plan and the confirmation changes this value, and the confirmation is refused — which is the property the
 * shipped shell script's own comment asked for and which its `sha256sum` of `ls` output could not give,
 * because that hashed NAMES. A set whose bytes changed after the plan changes its `setDigest`, and therefore
 * this, too.
 *
 * PATHS GO IN AND NEVER COME OUT. The project root and the destination are hashed so that two projects
 * holding identically-named sets cannot share a digest; neither ever reaches a rendered plan.
 */
export function canonicalRetentionOperation(
  resolved: ResolvedRetention,
  policy: RetentionPolicy,
  inventory: readonly InventoryEntry[],
  decisions: readonly RetentionDecision[],
  removals: readonly string[],
  protectedRestorable: string | null,
  restorableRemaining: number,
): string {
  return JSON.stringify([
    RETENTION_REPORT,
    RETENTION_VERSION,
    RETENTION_JOURNAL_VERSION,
    resolved.projectRoot,
    resolved.destinationDir,
    [policy.keepLast, policy.minAgeDays, policy.includeUnverified, policy.keepMinimumRestorable],
    inventory.map((entry) => [
      entry.name, entry.setClass, entry.takenAt, entry.takenAtMs, entry.schemaVersion, entry.setDigest,
      entry.restorable, entry.bytes, entry.entries, [...entry.findings],
    ]),
    decisions.map((decision) => [decision.name, decision.decision, decision.reason]),
    [...removals],
    protectedRestorable,
    restorableRemaining,
  ]);
}

export function digestOperation(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Inventory, verify, evaluate and produce the plan. Takes no lock, creates nothing, removes nothing.
 *
 * A REFUSED EVALUATION HAS NO DIGEST. `NO_RESTORABLE_SET` and `FLOOR_NOT_MET` throw rather than rendering,
 * because a plan that printed a confirmable digest beside "this would leave you with nothing" would be a plan
 * somebody could confirm.
 */
export function planRetention(
  resolved: ResolvedRetention,
  policy: RetentionPolicy,
  now: Date,
): RetentionPlan {
  assertUsablePolicy(policy);
  const inventory = inventoryDestination(resolved.destinationDir);
  const evaluation = evaluateRetention(inventory, policy, now);
  for (const refusal of evaluation.refusals) {
    if (refusal === 'NO_RESTORABLE_SET') {
      throw new MaintenanceRefused(
        'this backup destination holds no verified set that this build could restore, so nothing here will be '
        + 'removed. A retention run is a decision made while holding a good backup; on a day when there is not '
        + 'one, the thing to do is take one — npm run ops:complete-backup.');
    }
    throw new MaintenanceRefused(
      `this policy would leave ${evaluation.restorableRemaining} restorable set(s) and `
      + `--keep-minimum-restorable is ${policy.keepMinimumRestorable}. Nothing was removed. Raise --keep-last, `
      + 'or take a backup first.');
  }
  const byName = new Map(inventory.map((entry) => [entry.name, entry]));
  const bytesToRemove = evaluation.removals.reduce((total, name) => total + (byName.get(name)?.bytes ?? 0), 0);
  return {
    report: RETENTION_REPORT,
    version: RETENTION_VERSION,
    journalVersion: RETENTION_JOURNAL_VERSION,
    destinationName: resolved.destinationName,
    policy,
    evaluatedAt: new Date(now.getTime()).toISOString(),
    inventory,
    decisions: evaluation.decisions,
    removals: evaluation.removals,
    protectedRestorable: evaluation.protectedRestorable,
    restorableRemaining: evaluation.restorableRemaining,
    bytesToRemove,
    digest: digestOperation(canonicalRetentionOperation(resolved, policy, inventory, evaluation.decisions,
      evaluation.removals, evaluation.protectedRestorable, evaluation.restorableRemaining)),
    wrote: 'nothing',
    network: 'none',
    commands: 'none',
  };
}

// -----------------------------------------------------------------------------------------------------------
// Phase 310 — the journal
// -----------------------------------------------------------------------------------------------------------

/**
 * The per-set states, and why `deleting` had to exist.
 *
 * The first cut recorded `quarantined` and then recursively removed. A process that stopped existing inside
 * that removal left `quarantined` beside a HALF-CONSUMED tree, indistinguishable from `quarantined` beside an
 * intact one — so a resume could not both (a) re-verify an intact tree against what was planned before
 * destroying it and (b) finish a legitimately partial one. It has to do both, and it cannot without knowing
 * which it is looking at. `deleting` is written before the first `unlink` and is the only state under which a
 * tree that does not match its commitment may still be removed.
 */
export type RetentionEntryState = 'pending' | 'quarantined' | 'deleting' | 'removed' | 'failed';

export const RETENTION_ENTRY_STATES: readonly RetentionEntryState[] =
  Object.freeze(['pending', 'quarantined', 'deleting', 'removed', 'failed']);

export interface RetentionJournalEntry {
  readonly name: string;
  readonly state: RetentionEntryState;
  /** A closed sentence, only ever present on `failed`. */
  readonly reason: string | null;
}

export type RetentionPhase = 'removing' | 'abandoning';

export interface RetentionJournal {
  readonly journal: 'catalog-authority.retention';
  readonly version: typeof RETENTION_JOURNAL_VERSION;
  readonly planDigest: string;
  /**
   * The destination, RELATIVE to the project the journal is in — never an absolute path.
   *
   * It is re-resolved on every read, against the project root the journal was found in, and the operation's
   * digest is recomputed from that. So a journal moved into a different project does not describe an
   * operation there, and no operator's directory layout is written into a durable file.
   */
  readonly destination: string;
  readonly suffix: string;
  readonly policy: RetentionPolicy;
  /** The instant the decisions were evaluated at. Re-evaluated from, never merely re-hashed. */
  readonly evaluatedAt: string;
  readonly inventory: readonly InventoryEntry[];
  readonly decisions: readonly RetentionDecision[];
  readonly removals: readonly string[];
  readonly protectedRestorable: string | null;
  readonly restorableRemaining: number;
  readonly entries: readonly RetentionJournalEntry[];
  readonly phase: RetentionPhase;
}

export function retentionJournalPath(projectRoot: string): string {
  return join(projectRoot, RETENTION_JOURNAL_NAME);
}

class JournalRefusal extends Error {}

/**
 * Read the journal, and prove it describes an operation this program would perform.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHY RE-HASHING WAS NOT AUTHORITY, AND WHAT REPLACED IT.
 * -----------------------------------------------------------------------------------------------------
 *
 * The first cut validated the removal names and states, then recomputed the plan digest over the journal's
 * OWN recorded inventory and decisions. That proves a document agrees with itself. It does not prove the
 * document describes a decision this program would ever make — so somebody who understood the format could
 * change the protected set's decision to `remove`, append it to the removal list, RECOMPUTE the digest over
 * the edited content, and be obeyed. Every check passed, because every check was asking the document about
 * itself. The second check ("removals equal the decisions marked remove") was consistent with that forgery
 * too, and the test that claimed to cover it edited only one of the two lists, so it never met the actual
 * counterexample.
 *
 * The authority is now the EVALUATOR, not the document:
 *
 *   1. Every inventory row and every decision row is validated MEMBER BY MEMBER before anything maps, filters
 *      or casts over it — so a `null`, a scalar, a missing field or an unknown class is a closed refusal
 *      rather than a `TypeError` thrown out of a `.map` somewhere later.
 *   2. The evaluation instant is recorded, so `evaluateRetention(inventory, policy, evaluatedAt)` can be RUN
 *      again. Its decisions, its ordered removals, its protected set and its remaining count must equal the
 *      journal's EXACTLY. A forged decision therefore has to be one the evaluator itself produces — and the
 *      two unconditional protections and the not-ours rule are properties of the inventory row's CLASS, which
 *      no instant and no policy can talk past.
 *   3. Every removal must name an inventory row that is `VERIFIED`, or `UNVERIFIED` when the policy admitted
 *      those. A forgery that points the operation at a `FOREIGN` or `RESERVED` row dies here, before the
 *      evaluator is even asked.
 *   4. And the fabricated-inventory forgery — claiming somebody's directory is a VERIFIED set — dies later,
 *      on disk: nothing is deleted until the tree at that name has been re-verified against the set digest
 *      the inventory row records.
 */
export function readRetentionJournal(projectRoot: string): RetentionJournal | null {
  const path = retentionJournalPath(projectRoot);
  if (!existsSync(path)) return null;
  const refuse = (why: string): never => {
    throw new JournalRefusal(why);
  };
  try {
    return parseRetentionJournal(projectRoot, path, refuse);
  } catch (err) {
    if (err instanceof JournalRefusal) {
      throw new MaintenanceRefused(
        `this project holds a retention journal and ${err.message}. It was not written by a run of this `
        + 'program, so nothing here will act on it. Look at it, and remove it yourself once you are sure.');
    }
    if (err instanceof MaintenanceRefused) throw err;
    // A RUNTIME EXCEPTION IS A REFUSAL TOO. Anything that escapes as a `TypeError` from a malformed member is
    // still "this document is not one of ours", and it must never reach a caller as an unhandled throw whose
    // message carries whatever the runtime chose to put in it.
    throw new MaintenanceRefused(
      'this project holds a retention journal this build could not read as an operation. Nothing here will '
      + 'act on it. Look at it, and remove it yourself once you are sure.');
  }
}

function parseRetentionJournal(
  projectRoot: string,
  path: string,
  refuse: (why: string) => never,
): RetentionJournal {
  let raw: string;
  try {
    raw = readFileNoFollow(path, 'retention journal', MAX_JOURNAL_BYTES).bytes.toString('utf8');
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

  // THE VERSION BOUNDARY IS FIRST, so a document from an older schema is refused for BEING one rather than
  // for whichever field it happens to be missing.
  if (doc.journal !== 'catalog-authority.retention') return refuse('it is not this command\'s journal');
  if (doc.version !== RETENTION_JOURNAL_VERSION) {
    return refuse(`its version is ${describe(doc.version)} and this build writes ${RETENTION_JOURNAL_VERSION}`);
  }
  if (typeof doc.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.planDigest)) {
    return refuse('its plan digest is not a digest');
  }
  if (typeof doc.destination !== 'string' || doc.destination === '') return refuse('it records no destination');
  let resolvedDestination: ResolvedRetention;
  try {
    resolvedDestination = resolveRetentionDestination(projectRoot, doc.destination);
  } catch {
    return refuse('the destination it records is not a directory inside this project');
  }
  if (typeof doc.suffix !== 'string' || !RETENTION_SUFFIX_RE.test(doc.suffix)) {
    return refuse('its run suffix is not one this command produces');
  }
  if (doc.phase !== 'removing' && doc.phase !== 'abandoning') return refuse('its phase is not one this command writes');
  const policy = validatePolicy(doc.policy, refuse);
  const evaluated = instantOf(doc.evaluatedAt);
  if (evaluated === null) return refuse('the instant it evaluated its decisions at is not an instant');
  if (typeof doc.restorableRemaining !== 'number' || !Number.isInteger(doc.restorableRemaining)
    || doc.restorableRemaining < 0 || doc.restorableRemaining > MAX_DESTINATION_ENTRIES) {
    return refuse('the count of what it would leave is not a count');
  }
  if (doc.protectedRestorable !== null) {
    if (typeof doc.protectedRestorable !== 'string') return refuse('the set it protected is neither a name nor absent');
    try {
      assertUsableName(doc.protectedRestorable, 'protected set name');
    } catch {
      return refuse('the set it protected is not a usable name');
    }
  }

  // EVERY MEMBER, BEFORE ANYTHING MAPS OVER ANY OF THEM.
  if (!Array.isArray(doc.inventory)) return refuse('its inventory is not a list');
  if (doc.inventory.length > MAX_DESTINATION_ENTRIES) return refuse('it records more entries than this command inventories');
  const inventory = doc.inventory.map((row) => validateInventoryEntry(row, refuse));
  if (new Set(inventory.map((row) => row.name)).size !== inventory.length) {
    return refuse('a name appears in its inventory more than once');
  }
  const canonicalOrder = inventory.map((row) => row.name).slice().sort();
  if (JSON.stringify(inventory.map((row) => row.name)) !== JSON.stringify(canonicalOrder)) {
    return refuse('its inventory is not in the canonical order this command lists a destination in');
  }

  if (!Array.isArray(doc.decisions)) return refuse('its decisions are not a list');
  const decisions = doc.decisions.map((row) => validateDecision(row, refuse));
  if (decisions.length !== inventory.length) return refuse('its decisions do not cover its inventory');
  for (const [index, decision] of decisions.entries()) {
    if (decision.name !== inventory[index]!.name) {
      return refuse('its decisions are not its inventory, in order');
    }
  }

  if (!Array.isArray(doc.removals)) return refuse('its removal list is not a list');
  const known = new Map(inventory.map((row) => [row.name, row]));
  for (const name of doc.removals) {
    if (typeof name !== 'string') return refuse('a name in its removal list is not a name');
    try {
      assertUsableName(name, 'set name');
    } catch {
      return refuse('a name in its removal list is not one this command creates');
    }
    const row = known.get(name);
    if (row === undefined) return refuse('its removal list names something its own inventory does not');
    // THE CLASS GATE, BEFORE THE EVALUATOR IS EVEN ASKED. A document pointing this operation at a foreign
    // directory, a reserved name, an unreadable set or something that is not a directory is refused for what
    // it names, not for what it computed.
    if (!REMOVABLE_CLASSES.includes(row.setClass)) {
      return refuse('its removal list names something that is not a backup set this command took');
    }
    if (row.setClass === 'UNVERIFIED' && !policy.includeUnverified) {
      return refuse('its removal list names a set that does not verify, under a policy that did not admit one');
    }
  }
  const removals = doc.removals as readonly string[];
  if (new Set(removals).size !== removals.length) {
    return refuse('a name appears in its removal list more than once');
  }

  if (!Array.isArray(doc.entries)) return refuse('its per-set states are not a list');
  if (doc.entries.length !== removals.length) return refuse('its per-set states do not cover its removal list');
  const entries: RetentionJournalEntry[] = [];
  for (const [index, value] of doc.entries.entries()) {
    if (!isRecord(value)) return refuse('one of its per-set states is not a record');
    if (value.name !== removals[index]) return refuse('its per-set states are not its removal list, in order');
    if (typeof value.state !== 'string' || !RETENTION_ENTRY_STATES.includes(value.state as RetentionEntryState)) {
      return refuse('one of its per-set states is not a state this command writes');
    }
    const state = value.state as RetentionEntryState;
    if (state === 'failed') {
      if (typeof value.reason !== 'string' || value.reason === '') return refuse('a failed set carries no reason');
      if (value.reason.length > 2000) return refuse('a failure reason longer than this command writes');
    } else if (value.reason !== null) {
      return refuse('a set that did not fail carries a failure reason');
    }
    entries.push({
      name: value.name as string,
      state,
      reason: state === 'failed' ? (value.reason as string) : null,
    });
  }

  // THE DOCUMENT AGREES WITH ITSELF...
  const journal: RetentionJournal = {
    journal: 'catalog-authority.retention',
    version: RETENTION_JOURNAL_VERSION,
    planDigest: doc.planDigest,
    destination: doc.destination,
    suffix: doc.suffix,
    policy,
    evaluatedAt: evaluated.takenAt,
    inventory,
    decisions,
    removals,
    protectedRestorable: doc.protectedRestorable as string | null,
    restorableRemaining: doc.restorableRemaining,
    entries,
    phase: doc.phase,
  };
  const recomputed = digestOperation(canonicalRetentionOperation(
    resolvedDestination, journal.policy, journal.inventory, journal.decisions, journal.removals,
    journal.protectedRestorable, journal.restorableRemaining));
  if (recomputed !== journal.planDigest) {
    return refuse('the operation it describes does not hash to the plan digest it records');
  }

  // ...AND THE EVALUATOR AGREES WITH THE DOCUMENT. This is the check the first cut did not have, and it is
  // the only one that is not a question the document gets to answer about itself.
  let independent;
  try {
    independent = evaluateRetention(journal.inventory, journal.policy, new Date(evaluated.takenAtMs));
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
  if (independent.protectedRestorable !== journal.protectedRestorable) {
    return refuse('the set it says it protected is not the one this build protects');
  }
  if (independent.restorableRemaining !== journal.restorableRemaining) {
    return refuse('the count it says it would leave is not the one this build computes');
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

function validatePolicy(value: unknown, refuse: (why: string) => never): RetentionPolicy {
  if (!isRecord(value)) return refuse('it records no policy');
  const whole = (candidate: unknown, max: number): boolean =>
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 && candidate <= max;
  if (!whole(value.keepLast, MAX_KEEP_LAST) || !whole(value.minAgeDays, MAX_MIN_AGE_DAYS)
    || !whole(value.keepMinimumRestorable, MAX_KEEP_MINIMUM) || typeof value.includeUnverified !== 'boolean') {
    return refuse('the policy it records is not one this command accepts');
  }
  const policy: RetentionPolicy = {
    keepLast: value.keepLast as number,
    minAgeDays: value.minAgeDays as number,
    includeUnverified: value.includeUnverified,
    keepMinimumRestorable: value.keepMinimumRestorable as number,
  };
  try {
    assertUsablePolicy(policy);
  } catch {
    return refuse('the policy it records is not one this command accepts');
  }
  return policy;
}

/**
 * Every field of an inventory row, checked before anything reads any of them.
 *
 * EXPORTED IN PHASE 313. `ops:safety-set-lifecycle` persists the same destination inventory in its own
 * journal for the same reason — its evaluator has to be RE-RUN over it rather than the document re-hashed —
 * and a second validator for the same rows would be a second place for a field to stop being checked.
 * `refuse` is the caller's, so each command's refusals stay its own.
 */
export function validateInventoryEntry(value: unknown, refuse: (why: string) => never): InventoryEntry {
  if (!isRecord(value)) return refuse('one of its inventory rows is not a record');
  if (typeof value.name !== 'string' || value.name === '' || value.name.length > 128) {
    return refuse('one of its inventory rows has no usable name');
  }
  if (typeof value.setClass !== 'string' || !SET_CLASSES.includes(value.setClass as SetClass)) {
    return refuse('one of its inventory rows carries a class this build does not write');
  }
  const datedBoth = value.takenAt === null && value.takenAtMs === null;
  if (!datedBoth) {
    const instant = instantOf(value.takenAt);
    if (instant === null) return refuse('one of its inventory rows carries a date that is not an instant');
    if (value.takenAtMs !== instant.takenAtMs) {
      return refuse('one of its inventory rows carries a date and a moment that disagree');
    }
  }
  if (value.schemaVersion !== null
    && !(typeof value.schemaVersion === 'number' && Number.isInteger(value.schemaVersion)
      && value.schemaVersion >= 0 && value.schemaVersion <= 100000)) {
    return refuse('one of its inventory rows carries a schema version that is not one');
  }
  if (typeof value.setDigest !== 'string' || !/^([0-9a-f]{64})?$/.test(value.setDigest)) {
    return refuse('one of its inventory rows carries a set digest that is not one');
  }
  if (typeof value.restorable !== 'boolean') return refuse('one of its inventory rows does not say whether it is restorable');
  for (const field of ['bytes', 'entries'] as const) {
    const candidate = value[field];
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0
      || candidate > Number.MAX_SAFE_INTEGER) {
      return refuse(`one of its inventory rows carries a ${field} count that is not a count`);
    }
  }
  if (!Array.isArray(value.findings) || value.findings.length > 64
    || value.findings.some((finding) => typeof finding !== 'string' || finding.length > 64)) {
    return refuse('one of its inventory rows carries findings this build does not write');
  }
  // A CLASS AND A DIGEST THAT CANNOT COEXIST. Only a set with a readable manifest has a digest, and only
  // those two classes ever have one — so a `FOREIGN` row claiming a digest is not a row this build produced.
  const removable = REMOVABLE_CLASSES.includes(value.setClass as SetClass);
  if (!removable && value.setDigest !== '') {
    return refuse('one of its inventory rows claims a set digest for something that is not a set');
  }
  if (!removable && value.restorable) {
    return refuse('one of its inventory rows claims something that is not a set is restorable');
  }
  return {
    name: value.name,
    setClass: value.setClass as SetClass,
    takenAt: value.takenAt as string | null,
    takenAtMs: value.takenAtMs as number | null,
    schemaVersion: value.schemaVersion as number | null,
    setDigest: value.setDigest,
    restorable: value.restorable,
    bytes: value.bytes as number,
    entries: value.entries as number,
    findings: (value.findings as readonly string[]).slice(),
  };
}

function validateDecision(value: unknown, refuse: (why: string) => never): RetentionDecision {
  if (!isRecord(value)) return refuse('one of its decisions is not a record');
  if (typeof value.name !== 'string' || value.name === '' || value.name.length > 128) {
    return refuse('one of its decisions has no usable name');
  }
  if (value.decision !== 'keep' && value.decision !== 'remove') {
    return refuse('one of its decisions is neither keep nor remove');
  }
  if (typeof value.reason !== 'string' || !RETENTION_REASONS.includes(value.reason as never)) {
    return refuse('one of its decisions carries a reason this build does not write');
  }
  return { name: value.name, decision: value.decision, reason: value.reason as RetentionDecision['reason'] };
}

export function writeRetentionJournal(projectRoot: string, journal: RetentionJournal): void {
  // STAGED AND RENAMED, so a reader sees the previous complete journal or the new one and never a prefix.
  const staging = join(projectRoot, `${RETENTION_JOURNAL_NAME}.writing-${stagingSuffix()}`);
  const text = `${JSON.stringify(journal, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_JOURNAL_BYTES) {
    throw new MaintenanceRefused('this operation would produce a journal larger than this command reads back');
  }
  writePrivateFile(staging, text, 'retention journal');
  try {
    renameSync(staging, retentionJournalPath(projectRoot));
  } catch {
    try { unlinkSync(staging); } catch { /* the staging file is diagnostic; a failed cleanup is not the failure */ }
    throw new MaintenanceRefused('the retention journal could not be published into the project directory');
  }
}

export function clearRetentionJournal(projectRoot: string): void {
  try {
    unlinkSync(retentionJournalPath(projectRoot));
  } catch {
    throw new MaintenanceRefused('the retention journal could not be removed from the project directory');
  }
}

// -----------------------------------------------------------------------------------------------------------
// The quarantine directory, and what makes it OURS
// -----------------------------------------------------------------------------------------------------------

export interface QuarantineCommitment {
  readonly name: string;
  readonly setDigest: string;
  readonly bytes: number;
  readonly entries: number;
}

export interface QuarantineMarker {
  readonly marker: 'catalog-authority.retention-quarantine';
  readonly version: 1;
  readonly journalVersion: typeof RETENTION_JOURNAL_VERSION;
  readonly planDigest: string;
  readonly suffix: string;
  readonly removals: readonly string[];
  readonly commitments: readonly QuarantineCommitment[];
}

export function quarantineMarkerPath(quarantineDir: string): string {
  return join(quarantineDir, QUARANTINE_MARKER_NAME);
}

export function commitmentsOf(journal: RetentionJournal): readonly QuarantineCommitment[] {
  const known = new Map(journal.inventory.map((row) => [row.name, row]));
  return journal.removals.map((name) => {
    const row = known.get(name);
    if (row === undefined) throw new MaintenanceRefused('this operation names a set its own inventory does not');
    return { name, setDigest: row.setDigest, bytes: row.bytes, entries: row.entries };
  });
}

function expectedMarker(journal: RetentionJournal): QuarantineMarker {
  return {
    marker: 'catalog-authority.retention-quarantine',
    version: 1,
    journalVersion: RETENTION_JOURNAL_VERSION,
    planDigest: journal.planDigest,
    suffix: journal.suffix,
    removals: [...journal.removals],
    commitments: commitmentsOf(journal),
  };
}

/**
 * Prove the directory at the quarantine path is THIS operation's.
 *
 * -----------------------------------------------------------------------------------------------------
 * AN UNPREDICTABLE NAME IS NOT OWNERSHIP, AND AN ALLOWLISTED CHILD NAME IS NOT EITHER.
 * -----------------------------------------------------------------------------------------------------
 *
 * The first cut argued that a directory at `.catalog-retention.removing-<12 random hex>` must be ours because
 * nobody could guess the suffix, and checked only that its children were names the operation planned. After a
 * crash the suffix is written down in the journal, in a directory the operator owns — so it is not unguessable
 * any more, it is PUBLISHED. Replacing that directory with an ordinary one containing a directory named after
 * a planned set was enough to have this command recursively delete somebody else's files. And the check was
 * not run before the delete loop at all for an entry already recorded `quarantined`.
 *
 * A marker inside the tree, bound to the journal version, the plan digest, the suffix, the ordered removal
 * list and each set's exact planned commitment, is what ownership means here. It is verified before every
 * delete, every resume and every abandon cleanup.
 */
export function readQuarantineMarker(
  quarantineDir: string,
  journal: RetentionJournal,
): { readonly ok: true; readonly marker: QuarantineMarker } | { readonly ok: false; readonly why: string } {
  const path = quarantineMarkerPath(quarantineDir);
  if (!existsSync(path)) {
    return { ok: false, why: 'the quarantine directory carries no ownership marker of this operation\'s' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileNoFollow(path, 'retention quarantine marker', 4 * 1024 * 1024)
      .bytes.toString('utf8'));
  } catch {
    return { ok: false, why: 'the quarantine directory\'s ownership marker could not be read' };
  }
  if (!isRecord(parsed)) return { ok: false, why: 'the quarantine directory\'s ownership marker is not a record' };
  // COMPARED WHOLE, AGAINST WHAT THIS OPERATION WOULD HAVE WRITTEN. Field-by-field leniency is how a marker
  // that names the right operation while describing different sets ends up authorising a deletion.
  const want = JSON.stringify(expectedMarker(journal));
  const have = JSON.stringify({
    marker: parsed.marker, version: parsed.version, journalVersion: parsed.journalVersion,
    planDigest: parsed.planDigest, suffix: parsed.suffix, removals: parsed.removals,
    commitments: parsed.commitments,
  });
  if (want !== have) {
    return { ok: false, why: 'the quarantine directory\'s ownership marker does not describe this operation' };
  }
  return { ok: true, marker: expectedMarker(journal) };
}

/**
 * Create the quarantine directory, ALREADY MARKED, in one atomic publication.
 *
 * The predictable path goes from ABSENT straight to a directory holding a valid marker of this operation's:
 * the tree is built under an unpredictable, secret-free name, the marker is written inside it while it is
 * still invisible, and only then is it renamed into place. Not one byte of any set is moved until after that
 * rename, so the path is never observable in a state a reader has to guess about.
 */
function publishQuarantineDirectory(
  destinationDir: string,
  quarantineDir: string,
  journal: RetentionJournal,
  at: (point: RetentionFailpoint, name: string) => void,
): void {
  const claim = join(destinationDir, `${QUARANTINE_CLAIM_PREFIX}${randomBytes(9).toString('hex')}`);
  createPrivateDirectory(claim, 'retention quarantine claim directory');
  writePrivateFile(quarantineMarkerPath(claim), `${JSON.stringify(expectedMarker(journal), null, 2)}\n`,
    'retention quarantine marker');
  at('after-quarantine-marker-built', '');
  if (existsSync(quarantineDir)) {
    throw new MaintenanceRefused(
      'the retention quarantine name is already taken by something this operation did not publish');
  }
  try {
    renameSync(claim, quarantineDir);
  } catch {
    throw new MaintenanceRefused('the retention quarantine directory could not be published');
  }
  at('after-quarantine-marker-published', '');
}

/**
 * The quarantine directory this operation may use, published if it is not there and proved if it is.
 *
 * A directory at the predictable path that cannot prove it is ours is never written into, never read from and
 * never removed — the operation stops instead.
 */
function requireQuarantineDirectory(
  destinationDir: string,
  journal: RetentionJournal,
  at: (point: RetentionFailpoint, name: string) => void,
): string {
  const quarantineDir = join(destinationDir, quarantineDirName(journal.suffix));
  if (!existsSync(quarantineDir)) {
    publishQuarantineDirectory(destinationDir, quarantineDir, journal, at);
    return quarantineDir;
  }
  const stats = lstatSync(quarantineDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new MaintenanceRefused('the retention quarantine name is held by something that is not a directory');
  }
  const proof = readQuarantineMarker(quarantineDir, journal);
  if (!proof.ok) {
    throw new MaintenanceRefused(
      `${proof.why}. Nothing was moved into it and nothing inside it was removed. This is a state one run `
      + 'cannot produce, so this command stopped rather than guessing whose directory it is.');
  }
  // NOTHING INSIDE IT THAT THIS OPERATION DID NOT PUT THERE.
  const planned = new Set([...journal.removals, QUARANTINE_MARKER_NAME]);
  for (const entry of readdirSync(quarantineDir)) {
    if (!planned.has(entry)) {
      throw new MaintenanceRefused(
        'the retention quarantine directory holds something this operation did not put there, so nothing more '
        + 'was moved into it and nothing in it was removed');
    }
  }
  return quarantineDir;
}

/**
 * Prove the tree at `path` is EXACTLY the set this operation planned to remove.
 *
 * A commitment is not a name. The set digest binds the manifest's set name, its schema version and every
 * component's digest and byte count, so a directory that has been replaced, mutated, truncated or swapped for
 * a different set of ours fails this — and a fabricated inventory row claiming somebody's directory is a
 * VERIFIED set fails it too, which is where that forgery finally dies.
 */
export function proveSetIsPlanned(path: string, row: InventoryEntry): void {
  // THE PROOF ITSELF MOVED TO `maintenance-identity.ts` IN PHASE 313, unchanged, refusal wording included.
  // `ops:safety-set-lifecycle` has to ask exactly this question of the safety set inside a restore claim
  // immediately before it destroys it, and a second implementation of "is this still the set we committed
  // to" would be a second place for one of the four layers to quietly go missing.
  proveBackupSetIdentity(path, {
    name: row.name,
    setDigest: row.setDigest,
    takenAt: row.takenAt,
    schemaVersion: row.schemaVersion,
    bytes: row.bytes,
    entries: row.entries,
    verified: row.setClass === 'VERIFIED',
    findings: row.findings,
  });
}

// -----------------------------------------------------------------------------------------------------------
// Phase 309 — execution
// -----------------------------------------------------------------------------------------------------------

/**
 * Every combination of a recorded per-set state and what the filesystem actually holds, and the one answer
 * to each — `null` for a state a run of this program can be in, a closed sentence for one it cannot.
 *
 * -----------------------------------------------------------------------------------------------------
 * TOTAL, AND EXPORTED, BECAUSE THE PREVIOUS TABLE WAS NEITHER.
 * -----------------------------------------------------------------------------------------------------
 *
 * Five states times two presences times two presences is TWENTY combinations. The first cut enumerated ten
 * of them in a comment and a static tuple list in the suite, called it the full matrix, and left out
 * `failed` entirely, both `deleting`-back-in-the-destination cases, `quarantined` back in the destination,
 * and every `removed` case except the ordinary one. `removed` beside a tree that has REAPPEARED was the
 * worst of them: the sweep skipped `removed` outright, so a set this operation had recorded as destroyed,
 * with something now sitting at its name, produced an incomplete report naming no failure at all.
 *
 * It is a function rather than a comment so the executor and the suite read the SAME table, and the suite
 * can enumerate all twenty and then drive the executor through every one of them.
 */
export function preconditionRefusal(
  state: RetentionEntryState,
  inDestination: boolean,
  inQuarantine: boolean,
): string | null {
  // BOTH PLACES IS NEVER LEGAL, in any state. One run cannot produce it, and guessing which of the two is
  // the real set is exactly the guess this family never makes.
  if (inDestination && inQuarantine) {
    return 'this set is present both in the destination and in the quarantine directory, which one run '
      + 'cannot produce. Nothing was removed for it, and nothing after it was touched.';
  }
  switch (state) {
    case 'pending':
    case 'failed':
      // `failed` IS `pending` WITH A HISTORY. It is only ever written for an entry that had NOT reached
      // `deleting` — see `stop` — so its tree, wherever it is, is whole. An operator who has dealt with
      // whatever stopped the run resumes, and this entry is retried from wherever it actually is.
      if (!inDestination && !inQuarantine) {
        return 'this set is in neither the destination nor the quarantine directory. Something removed it '
          + 'outside this command, and this run will not report having removed it.';
      }
      return null;
    case 'quarantined':
      if (inDestination) {
        return 'this set is recorded as set aside and is back in the destination, which one run cannot '
          + 'produce.';
      }
      if (!inQuarantine) {
        // WITH A `deleting` STATE THIS IS IMPOSSIBLE. A removal is always preceded by a record, so a
        // quarantined set that is gone was removed by something that is not this command.
        return 'this set was recorded as set aside and is no longer in the quarantine directory. Nothing '
          + 'this command does removes a set without recording that it was about to, so something else did. '
          + 'Nothing after it was touched.';
      }
      return null;
    case 'deleting':
      if (inDestination) {
        return 'this set is recorded as being removed and is back in the destination, which one run cannot '
          + 'produce.';
      }
      // PRESENT: a tree that may be partial, finished under the ownership marker. ABSENT: the removal
      // landed and its record did not. Both are states a kill really produces.
      return null;
    case 'removed':
      if (inDestination || inQuarantine) {
        return 'this set is recorded as REMOVED and something is at its name again. This operation destroyed '
          + 'it, so whatever is there now is not the set that was planned and is not this command\'s to act '
          + 'on — a deletion frees a name, and a later backup can legitimately take it. Nothing after it was '
          + 'touched. Close this operation with --abandon, then plan a fresh one.';
      }
      return null;
  }
}

/** Named boundaries a test kills a real run at. Never used in production; the default hook does nothing. */
export type RetentionFailpoint =
  | 'after-journal'
  | 'after-quarantine-marker-built'
  | 'after-quarantine-marker-published'
  | 'after-quarantine-rename'
  | 'after-quarantine-mark'
  | 'after-deleting-mark'
  | 'after-remove'
  | 'after-abandon-rename';

export interface RetentionDeps {
  readonly now?: () => Date;
  readonly suffix?: () => string;
  /** A hook the acceptance suite uses to stop a REAL run at a named boundary. */
  readonly at?: (point: RetentionFailpoint, name: string) => void;
  /**
   * The journal writer, injectable for one reason: a journal that CANNOT BE WRITTEN is the failure mode with
   * no test unless it can be made to happen. A full disk, a read-only project directory or a permission
   * change mid-run all produce it, and it is the one failure that arrives after sets have already moved.
   */
  readonly journalWriter?: (projectRoot: string, journal: RetentionJournal) => void;
  /** The journal clear, injectable for the same reason: a clear that fails after an abandon has moved things. */
  readonly journalClearer?: (projectRoot: string) => void;
  /**
   * The recursive removal, injectable for one reason: a removal that unlinks SOME children and then throws
   * is the state `deleting` exists for, and there is no other way to produce it deterministically. A kill
   * cannot be aimed between two `unlink` calls inside a shipped primitive, and a removal that failed before
   * touching anything is a different state.
   */
  readonly remover?: (path: string, what: string, maxEntries: number) => number;
}

/**
 * A failure that happened AFTER this command had already moved or removed something.
 *
 * THE DEFECT THIS CLOSES. Every failure here used to leave `runRetention` through the same `throw` as a
 * pre-effect refusal, and the CLI exits `3` for those — the code it documents as "refused before anything was
 * moved". A scheduler, or an operator reading the exit code, would be told nothing happened by a run that had
 * already deleted backup sets and left more of them in a quarantine directory nothing else will ever mention.
 *
 * IT ALSO COVERS EFFECTS FROM A PREVIOUS PROCESS. A resume of an operation that already moved sets carries
 * this even if this process has not itself renamed anything yet — the operation's effects are what matter to
 * whoever is reading, not which process performed them.
 */
export class RetentionFailed extends MaintenanceRefused {
  readonly report: RetentionReport;

  constructor(message: string, report: RetentionReport) {
    super(message);
    this.name = 'RetentionFailed';
    this.report = report;
  }
}

/** The same, for an abandon: a rename happened and then something else did not. */
export class RetentionAbandonFailed extends MaintenanceRefused {
  readonly report: RetentionAbandonReport;

  constructor(message: string, report: RetentionAbandonReport) {
    super(message);
    this.name = 'RetentionAbandonFailed';
    this.report = report;
  }
}

export type RetentionMode =
  | { readonly kind: 'run'; readonly confirm: string }
  | { readonly kind: 'resume'; readonly confirm: string };

export interface RetainedArtifacts {
  /** The quarantine directory's own name inside the destination. Never a path. */
  readonly quarantine: string;
  readonly holds: readonly string[];
  readonly warning: string;
}

export type RetentionState = 'REMOVED' | 'REMOVED_BUT_UNPROVEN' | 'INCOMPLETE';

export interface RetentionReport {
  readonly report: typeof RETENTION_REPORT;
  readonly version: typeof RETENTION_VERSION;
  readonly ok: boolean;
  readonly state: RetentionState;
  readonly destinationName: string;
  readonly policy: RetentionPolicy;
  readonly planDigest: string;
  readonly planned: readonly string[];
  readonly removed: readonly string[];
  readonly failed: readonly { readonly name: string; readonly reason: string }[];
  /** Named removals this run deliberately did not touch after it stopped. Abandon is still available for them. */
  readonly untouched: readonly string[];
  readonly kept: number;
  readonly protectedRestorable: string | null;
  /** The protected set, re-verified FROM DISK after every removal. */
  readonly protectedRestorableVerified: boolean;
  readonly bytesRemoved: number;
  readonly retained: RetainedArtifacts | null;
  readonly journalCleared: boolean;
  readonly commands: 'none';
  readonly network: 'none';
  readonly notes: readonly string[];
}

/**
 * Prune a backup destination according to a policy an operator read and confirmed.
 *
 * THE ORDER IS THE GUARANTEE:
 *   1. resolve, and refuse a project part way through a restore
 *   2. take the PROJECT lock, then the DESTINATION lock — always that order, so two runs cannot deadlock
 *   3. re-inventory and re-verify from scratch UNDER THE LOCK, and require the plan digest to be the one
 *      that was confirmed
 *   4. journal the whole committed decision list before the first effect
 *   5. publish an OWNED quarantine directory, then rename every removal into it, oldest first — reversible,
 *      and nothing is destroyed yet
 *   6. for each, prove the tree is the set that was planned, record `deleting`, then remove it
 *   7. re-verify, from disk, the set this run promised to protect
 *   8. release both locks in a `finally`, innermost first
 *
 * AND ANY IMPOSSIBLE STATE STOPS IT. Once the filesystem or the ownership evidence says something one run
 * cannot have produced, this does not carry on destroying the other candidates: it records the entry, keeps
 * the journal, leaves everything it has not yet touched exactly where it is, and returns the partial report.
 * Abandon remains available for everything that was only ever renamed.
 */
export function runRetention(
  request: RetentionRequest,
  policy: RetentionPolicy,
  deps: RetentionDeps,
  mode: RetentionMode,
): RetentionReport {
  const now = deps.now ?? (() => new Date());
  const at = deps.at ?? (() => { /* production does nothing here */ });
  const writeJournal = deps.journalWriter ?? writeRetentionJournal;
  const clearJournal = deps.journalClearer ?? clearRetentionJournal;
  const remove = deps.remover ?? removeOwnTreeNoFollow;
  // A CHEAP, HOPELESS-CASE REFUSAL BEFORE THE LOCK, re-established under it below. Both are needed: this one
  // so a project part way through a restore refuses without contending for anything, that one because a
  // check made before a lock is a check about a moment that has passed.
  const projectRoot = resolveRetentionProject(request.projectRoot);

  const locks = MaintenanceLocks.open(projectRoot);
  try {
    assertNoRestoreInProgress(projectRoot,
      'a restore of this installation started while this command was waiting for the lock. Nothing was '
      + 'removed. Finish or unwind that restore first.');
    const existing = readRetentionJournal(projectRoot);
    if (mode.kind === 'run' && existing !== null) {
      throw new MaintenanceRefused(
        'this project holds an interrupted retention journal. A destination part way through a prune is not a '
        + 'starting point, and re-planning over it would decide against an inventory that is missing the sets '
        + 'the interrupted run already took. Continue it with --resume, or unwind it with --abandon.');
    }
    if (mode.kind === 'resume') {
      if (existing === null) {
        throw new MaintenanceRefused('there is no interrupted retention run in this project to resume');
      }
      if (existing.phase === 'abandoning') {
        throw new MaintenanceRefused(
          'this project\'s retention journal records an interrupted ABANDON. Continuing the prune would destroy '
          + 'sets an operator had just decided to put back. Finish it with --abandon.');
      }
      if (existing.planDigest !== mode.confirm) {
        throw new MaintenanceRefused(
          '--resume was given a digest that is not the interrupted run\'s. A resume continues the operation the '
          + 'journal recorded, and nothing else.');
      }
    }

    // A RESUME'S DESTINATION COMES FROM THE JOURNAL, NOT FROM A COMMAND LINE. `--resume` takes only
    // `--project`, so the destination flag would carry its default; re-deriving from it would point the
    // recovery at a directory the interrupted run never touched.
    const resolved = mode.kind === 'resume'
      ? resolveRetentionDestination(projectRoot, existing!.destination)
      : resolveRetentionDestination(projectRoot, request.destination);

    // THE SECOND LOCK DOMAIN, AND EXACTLY WHAT IT COVERS SINCE PHASES 321-328. The project lock is the one
    // every command in this family takes, so holding it is what stops this run racing a set being published
    // or read IN THIS PROJECT. The destination lock is taken IN the destination, so it holds against ANOTHER
    // PROJECT pointed at the same physical directory — and all four backup-family commands now take it, so
    // "two commands cannot be half way through one destination at once" is true of `ops:complete-backup` and
    // `ops:complete-restore` as well, which is exactly what the Phase 313-320 report recorded as open.
    locks.lockDestination(resolved.destinationDir);

    let journal: RetentionJournal;
    if (mode.kind === 'run') {
      const replanned = planRetention(resolved, policy, now());
      if (replanned.digest !== mode.confirm) {
        throw new MaintenanceRefused(
          'this operation is not the one the plan was read against. Nothing was removed. A set has been taken, '
          + 'removed or changed since then; or the policy flags are not the ones that were planned; or enough '
          + 'TIME has passed that a set has crossed --min-age-days, which is a different decision about a '
          + 'different set of sets and is refused for the same reason as any other. Run --plan again and read '
          + 'the new list.');
      }
      const suffix = (deps.suffix ?? stagingSuffix)();
      if (!RETENTION_SUFFIX_RE.test(suffix)) {
        throw new MaintenanceRefused('the retention run suffix is not one this command produces');
      }
      journal = {
        journal: 'catalog-authority.retention',
        version: RETENTION_JOURNAL_VERSION,
        planDigest: replanned.digest,
        destination: resolved.destinationRelative,
        suffix,
        policy: replanned.policy,
        evaluatedAt: replanned.evaluatedAt,
        inventory: replanned.inventory,
        decisions: replanned.decisions,
        removals: replanned.removals,
        protectedRestorable: replanned.protectedRestorable,
        restorableRemaining: replanned.restorableRemaining,
        entries: replanned.removals.map((name) => ({ name, state: 'pending' as const, reason: null })),
        phase: 'removing',
      };
      writeJournal(resolved.projectRoot, journal);
      at('after-journal', '');
    } else {
      journal = existing!;
    }

    return execute(resolved, journal, at, writeJournal, clearJournal, remove);
  } finally {
    // INNERMOST FIRST, and every path out runs this. The order is the stack's, not this call site's.
    locks.release();
  }
}

function execute(
  resolved: ResolvedRetention,
  start: RetentionJournal,
  at: (point: RetentionFailpoint, name: string) => void,
  writeJournal: (projectRoot: string, journal: RetentionJournal) => void,
  clearJournal: (projectRoot: string) => void,
  remove: (path: string, what: string, maxEntries: number) => number,
): RetentionReport {
  let journal = start;
  const quarantine = quarantineDirName(journal.suffix);
  const quarantineDir = join(resolved.destinationDir, quarantine);
  const byName = new Map(journal.inventory.map((entry) => [entry.name, entry]));
  const notes: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  const removed: string[] = [];
  let bytesRemoved = 0;
  let stopped = false;

  // HAS THIS OPERATION ALREADY MOVED OR REMOVED ANYTHING?
  //
  // THE DEFECT THIS CLOSES. It used to start `false` and be set only by an effect THIS process performed. A
  // resume of an operation that had already renamed three sets aside, whose first journal write then failed,
  // therefore left as a pre-effect refusal carrying no report — telling an operator nothing happened about a
  // destination that was part way through a prune. What matters to a reader is what the OPERATION has done,
  // so this is seeded from the journal and the filesystem before anything else runs.
  let effected = journal.entries.some((entry) => entry.state !== 'pending') || existsSync(quarantineDir);

  const mark = (name: string, state: RetentionEntryState, reason: string | null): void => {
    journal = {
      ...journal,
      entries: journal.entries.map((entry) => (entry.name === name ? { name, state, reason } : entry)),
    };
    writeJournal(resolved.projectRoot, journal);
  };

  /**
   * Record the failure, and STOP. Nothing after an impossible state is destroyed.
   *
   * -----------------------------------------------------------------------------------------------------
   * `deleting` IS A COMMITMENT THAT SURVIVES FAILURE.
   * -----------------------------------------------------------------------------------------------------
   *
   * THE DEFECT THIS CLOSES. `removeOwnTreeNoFollow` can unlink some children and then throw — a file another
   * process holds open, a permission that changed under it, an `rmdir` that will not complete. The tree is
   * then PARTIAL, and `deleting` is the only thing that authorises finishing it. Rewriting that entry to
   * `failed` threw the authorisation away: a resume would treat `failed` beside a quarantined tree as an
   * intact one and try to prove it against its commitment, which a half-deleted set can never satisfy. The
   * operation was stranded — it could not finish, and `--abandon` would not put a truncated tree back either.
   *
   * So a failure never moves an entry OUT of `deleting`. The reason travels in the report, which is where an
   * operator reads it; the journal's job is to describe the state a recovery is allowed to act on, and after
   * the first `unlink` that state is `deleting` whatever else went wrong.
   */
  const stop = (name: string, reason: string): void => {
    if (stateOf(name) !== 'deleting') mark(name, 'failed', reason);
    failed.push({ name, reason });
    stopped = true;
  };

  try {
    // 4b. THE PRECONDITION SWEEP, BEFORE THE FIRST EFFECT OF THIS PROCESS.
    //
    // THE DEFECT THIS CLOSES. The impossible states were each detected where they were acted on — so a
    // candidate whose quarantined tree had vanished was only noticed in the DELETE phase, by which time the
    // quarantine phase had already renamed three other sets aside. Nothing was destroyed, but the run had
    // gone on doing work after the destination had already been proved to be in a state one run cannot
    // produce. Every entry's (recorded state, in destination?, in quarantine?) triple is now cross-validated
    // FIRST, and a single impossible one stops the operation with zero effects from this process.
    const impossible = sweepPreconditions();
    if (impossible !== null) {
      stop(impossible.name, impossible.reason);
      return finishStopped();
    }
    return performRemovals();
  } catch (err) {
    if (!effected) throw err;
    // SETS HAVE ALREADY MOVED OR GONE. A `throw` from here reaches the CLI's refusal path, which exits with
    // the code this command documents as "refused before anything was moved" — so it is raised as the
    // failure it is, carrying a report that names the quarantine directory and everything in it.
    throw new RetentionFailed(
      `${safeReason(err)} `
      + '\nThis failure arrived AFTER this operation had already started moving backup sets. Read the report '
      + 'above: it names what is gone, what is still in the quarantine directory, and what that directory '
      + 'holds. The journal was kept. Continue with --resume or put back what is left with --abandon.',
      buildReport('INCOMPLETE', false, false));
  }

  /**
   * Cross-validate every entry's recorded state against what the filesystem actually holds.
   *
   * The whole table is `preconditionRefusal`, which is total over all twenty combinations. This walks every
   * entry — INCLUDING the ones recorded `removed`, which the first cut skipped — and returns the first
   * combination a run of this program cannot be in.
   */
  function sweepPreconditions(): { readonly name: string; readonly reason: string } | null {
    for (const entry of journal.entries) {
      const inDestination = existsSync(join(resolved.destinationDir, entry.name));
      const inQuarantine = existsSync(quarantineDir) && existsSync(join(quarantineDir, entry.name));
      const refusal = preconditionRefusal(entry.state, inDestination, inQuarantine);
      if (refusal !== null) return { name: entry.name, reason: refusal };
    }
    return null;
  }

  /** The report for a run that stopped before it did anything of its own. */
  function finishStopped(): RetentionReport {
    // WHAT THE OPERATION HAS ALREADY REMOVED IS STILL WHAT IT HAS REMOVED, bytes included: a stopped resume
    // reporting four names beside "freed ~0 B" would be describing its own process rather than the prune.
    for (const entry of journal.entries) {
      if (entry.state !== 'removed') continue;
      removed.push(entry.name);
      bytesRemoved += byName.get(entry.name)?.bytes ?? 0;
    }
    notes.push('This run STOPPED at a state one run cannot produce, before it moved or removed anything of '
      + 'its own. Everything still listed as untouched is exactly where it was, and everything already set '
      + 'aside can still be put back with --abandon.');
    notes.push('The journal was kept: a partial prune is a state that must stay visible.');
    notes.push('Nothing was downloaded, fetched, played or acquired, and no command of any kind was issued: '
      + 'this run was filesystem work under a lock.');
    return buildReport('INCOMPLETE', false, false);
  }

  function performRemovals(): RetentionReport {
    // 5. QUARANTINE. A rename inside the destination is same-filesystem and atomic: a set name is observed
    // holding a whole set, or nothing. Nothing is destroyed in this phase and all of it is reversible.
    for (const entry of journal.entries) {
      if (stopped) break;
      const current = stateOf(entry.name);
      if (current === 'removed' || current === 'quarantined' || current === 'deleting') continue;
      const source = join(resolved.destinationDir, entry.name);
      const target = join(quarantineDir, entry.name);
      const inDestination = existsSync(source);
      const inQuarantine = existsSync(quarantineDir) && existsSync(target);
      if (inDestination && inQuarantine) {
        // ONE PROCESS CANNOT PRODUCE THIS, and guessing which of the two is the real set is exactly the guess
        // this family never makes.
        stop(entry.name, 'this set is present both in the destination and in the quarantine directory, which '
          + 'one run cannot produce. Nothing was removed for it, and nothing after it was touched.');
        continue;
      }
      if (!inDestination && inQuarantine) {
        // An interrupted rename: the effect landed and the record did not. The tree is adopted only after it
        // has been proved to be the set this operation planned — the first cut adopted it on the strength of
        // its NAME and then deleted it.
        let owned;
        try {
          owned = requireQuarantineDirectory(resolved.destinationDir, journal, at);
          proveSetIsPlanned(join(owned, entry.name), byName.get(entry.name)!);
        } catch (err) {
          stop(entry.name, safeReason(err));
          continue;
        }
        effected = true;
        mark(entry.name, 'quarantined', null);
        notes.push(`${entry.name} was already in the quarantine directory: an interrupted rename, proved to be `
          + 'the set that was planned, and adopted rather than repeated.');
        continue;
      }
      if (!inDestination && !inQuarantine) {
        stop(entry.name, 'this set is in neither the destination nor the quarantine directory. Something '
          + 'removed it outside this command, and this run will not report having removed it.');
        continue;
      }
      try {
        // PROVED BEFORE IT IS MOVED, NOT ONLY BEFORE IT IS DELETED.
        //
        // A rename is reversible, which is why the first cut gated only the deletion — and it is still an
        // effect on a directory in somebody's backup folder. A journal whose inventory row FABRICATES a set
        // (claiming a stranger's directory is a VERIFIED set of ours) passes every document-level check, so
        // without this it would have this command pick that directory up and carry it into a quarantine tree
        // before anything noticed. The commitment is checked here too, and the directory never moves.
        proveSetIsPlanned(source, byName.get(entry.name)!);
        requireQuarantineDirectory(resolved.destinationDir, journal, at);
        effected = true;
        renameSync(source, target);
      } catch (err) {
        stop(entry.name, err instanceof MaintenanceRefused ? err.message
          : 'this set could not be renamed aside, so it was left exactly where it is');
        continue;
      }
      at('after-quarantine-rename', entry.name);
      mark(entry.name, 'quarantined', null);
      at('after-quarantine-mark', entry.name);
    }

    // 6. DELETE, oldest first, each proved to be the planned set and each bounded by what its own manifest
    // declared it to be.
    //
    // `removed` AND `bytesRemoved` ARE ABOUT THE OPERATION, NOT ABOUT THIS PROCESS. A resume that finds a set
    // already recorded as removed reports it — and reports what it freed — because an operator reading the
    // final report of a resumed prune is asking what the whole prune did, not what its last process saw.
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
        // WITH A `deleting` STATE THIS IS IMPOSSIBLE. A removal is always preceded by a record, so a
        // quarantined set that is gone was removed by something that is not this command.
        stop(entry.name, 'this set was recorded as set aside and is no longer in the quarantine directory. '
          + 'Nothing this command does removes a set without recording that it was about to, so something '
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
        owned = requireQuarantineDirectory(resolved.destinationDir, journal, at);
      } catch (err) {
        stop(entry.name, safeReason(err));
        continue;
      }
      if (current === 'quarantined') {
        // AN INTACT, NOT-YET-CONSUMED TREE IS PROVED AGAINST WHAT WAS PLANNED, EVERY TIME, IMMEDIATELY BEFORE
        // IT IS DESTROYED. A tree replaced or mutated between the rename and this instant is refused.
        try {
          proveSetIsPlanned(join(owned, entry.name), byName.get(entry.name)!);
        } catch (err) {
          stop(entry.name, safeReason(err));
          continue;
        }
        try {
          mark(entry.name, 'deleting', null);
        } catch (err) {
          stop(entry.name, safeReason(err));
          continue;
        }
        at('after-deleting-mark', entry.name);
      }
      // A `deleting` TREE MAY BE PARTIAL, so it is not re-verified — that is the whole reason the state
      // exists. What authorises finishing it is the ownership marker above and this entry's own record.
      try {
        effected = true;
        remove(join(owned, entry.name), `backup set ${entry.name}`,
          removalEntryBound(byName.get(entry.name)?.entries ?? 0));
      } catch (err) {
        stop(entry.name, err instanceof MaintenanceRefused ? err.message
          : 'this set could not be removed from the quarantine directory');
        continue;
      }
      at('after-remove', entry.name);
      mark(entry.name, 'removed', null);
      recordRemoved(entry.name);
    }

    // 7. THE PROOF. The set this run promised to protect is verified again, FROM DISK, after every removal.
    // It should be untouched — that is the point — and a run that removed four sets and can no longer verify
    // the one it said it was keeping has not succeeded, whatever it deleted.
    let protectedRestorableVerified = false;
    if (journal.protectedRestorable !== null) {
      try {
        const proof = verifyBackupSet(join(resolved.destinationDir, journal.protectedRestorable));
        protectedRestorableVerified = proof.ok && proof.restorableUnderThisBuild;
      } catch {
        protectedRestorableVerified = false;
      }
    }

    const outstanding = journal.entries.filter((entry) => entry.state !== 'removed');
    const complete = !stopped && failed.length === 0 && outstanding.length === 0 && !quarantineSurvives();
    let journalCleared = false;
    if (complete) {
      clearJournal(resolved.projectRoot);
      journalCleared = true;
    } else {
      notes.push('The journal was kept: this run did not finish, and a partial prune is a state that must stay '
        + 'visible. Continue it with --resume, or put the quarantined sets back with --abandon.');
    }
    if (stopped) {
      notes.push('This run STOPPED at the first state one run cannot produce. Nothing after it was renamed or '
        + 'removed: everything still listed as untouched is exactly where it was, and everything already set '
        + 'aside can still be put back with --abandon.');
    }

    const state: RetentionState = !complete ? 'INCOMPLETE'
      : protectedRestorableVerified ? 'REMOVED' : 'REMOVED_BUT_UNPROVEN';
    if (state === 'REMOVED_BUT_UNPROVEN') {
      notes.push('Every planned removal completed AND the set this run promised to keep could not be verified '
        + 'afterwards. Do not treat this destination as a recovery point until you have looked at it.');
    }
    notes.push('Nothing was downloaded, fetched, played or acquired, and no command of any kind was issued: '
      + 'this run was filesystem work under a lock.');
    return buildReport(state, state === 'REMOVED', journalCleared, protectedRestorableVerified);
  }

  function stateOf(name: string): RetentionEntryState {
    return journal.entries.find((entry) => entry.name === name)!.state;
  }

  /**
   * Remove the quarantine directory when only its marker is left, and answer whether it is still there.
   *
   * The marker is removed only under a proof that the directory is ours, and the directory only when nothing
   * but the marker remains. Called on the success path and on the failure path, because a retained
   * secret-bearing directory is the one artifact that has to be named on BOTH.
   */
  function quarantineSurvives(): boolean {
    return !tryRemoveOwnedQuarantine(quarantineDir, journal);
  }

  function buildReport(
    state: RetentionState,
    ok: boolean,
    journalCleared: boolean,
    protectedRestorableVerified = false,
  ): RetentionReport {
    let retained: RetainedArtifacts | null = null;
    if (quarantineSurvives()) {
      retained = describeRetained(quarantineDir, quarantine);
    }
    // KEPT COUNTS BACKUP SETS, NOT DIRECTORY ENTRIES. Counting every `keep` decision would fold an operator's
    // own folders, this product's in-flight artifacts and a stray file into a number labelled "kept", which
    // is the number somebody checks to see how many backups they still have.
    const classOf = new Map(journal.inventory.map((item) => [item.name, item.setClass]));
    const kept = journal.decisions.filter((decision) => decision.decision === 'keep'
      && (classOf.get(decision.name) === 'VERIFIED' || classOf.get(decision.name) === 'UNVERIFIED')).length;
    const untouched = journal.entries
      .filter((entry) => entry.state === 'pending')
      .map((entry) => entry.name);
    return {
      report: RETENTION_REPORT,
      version: RETENTION_VERSION,
      ok,
      state,
      destinationName: resolved.destinationName,
      policy: journal.policy,
      planDigest: journal.planDigest,
      planned: journal.removals,
      removed,
      failed,
      untouched,
      kept,
      protectedRestorable: journal.protectedRestorable,
      protectedRestorableVerified,
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
 * is this operation's, and it removes the directory only when the marker is the last thing in it: a tree
 * still holding a set is never removed as a container.
 */
function tryRemoveOwnedQuarantine(quarantineDir: string, journal: RetentionJournal): boolean {
  if (!existsSync(quarantineDir)) return true;
  const proof = readQuarantineMarker(quarantineDir, journal);
  if (!proof.ok) return false;
  let leftovers: readonly string[];
  try {
    leftovers = readdirSync(quarantineDir).slice().sort();
  } catch {
    return false;
  }
  if (leftovers.some((entry) => entry !== QUARANTINE_MARKER_NAME)) return false;
  try {
    unlinkSync(quarantineMarkerPath(quarantineDir));
    rmdirSync(quarantineDir);
  } catch {
    return false;
  }
  return !existsSync(quarantineDir);
}

function describeRetained(quarantineDir: string, quarantine: string): RetainedArtifacts {
  let holds: readonly string[] = [];
  try {
    holds = readdirSync(quarantineDir).slice().sort().filter((entry) => entry !== QUARANTINE_MARKER_NAME);
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
 * THE DEFECT THIS CLOSES. The post-effect failure carried `err.message` through for anything at all — and an
 * unexpected error here is the runtime's, whose message routinely carries the absolute path it failed on
 * (`ENOENT: no such file or directory, open '/mnt/user/appdata/...'`). That message goes into a report, and
 * a report is the thing an operator pastes into an issue. This is `maintenance-cli-shared`'s rule applied
 * where the message is BUILT rather than only where it is printed, because by then it is inside a durable
 * report object as well as on a terminal.
 */
function safeReason(err: unknown): string {
  if (err instanceof MaintenanceRefused) return err.message;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const named = typeof code === 'string' && /^[A-Z]{1,16}$/.test(code) ? ` (${code})` : '';
  return `this prune failed for a reason it does not have safe wording for${named}.`;
}

// -----------------------------------------------------------------------------------------------------------
// Phase 310 — abandon
// -----------------------------------------------------------------------------------------------------------

export type RetentionAbandonState = 'ABANDONED' | 'ABANDONED_WITH_LOSS' | 'PARTIAL';

export interface RetentionAbandonReport {
  readonly report: typeof RETENTION_REPORT;
  readonly version: typeof RETENTION_VERSION;
  /** True ONLY for a clean unwind: everything put back, nothing gone, nothing retained. */
  readonly ok: boolean;
  readonly state: RetentionAbandonState;
  readonly destinationName: string;
  readonly planDigest: string;
  /** Sets renamed back into the destination by this abandon. */
  readonly putBack: readonly string[];
  /** Sets this abandon cannot bring back, because they were already deleted. Named, always. */
  readonly goneForever: readonly string[];
  readonly unresolved: readonly string[];
  readonly retained: RetainedArtifacts | null;
  readonly journalCleared: boolean;
  readonly commands: 'none';
  readonly network: 'none';
  readonly notes: readonly string[];
}

/**
 * Put back every set this operation quarantined and has not yet deleted.
 *
 * IT TAKES ONLY THE PROJECT ROOT. The destination, the suffix and the names come from the journal the
 * interrupted run wrote — not from flags typed now, which can differ from the run that actually renamed
 * those directories.
 *
 * -----------------------------------------------------------------------------------------------------
 * AN ABANDON THAT LOST A SET IS NOT A SUCCESS, AND SAYS SO.
 * -----------------------------------------------------------------------------------------------------
 *
 * The first cut set `ok` from `unresolved` alone, so a run that put one set back and reported another as
 * GONE FOREVER rendered `RESULT: ABANDONED` and exited zero — directly contradicting its own comment, the
 * design document, and the operator's reading of the word. `ok` is now a clean unwind and nothing else;
 * `ABANDONED_WITH_LOSS` is its own state, and the CLI exits non-zero for it.
 */
export function abandonRetention(projectRoot: string, deps: RetentionDeps = {}): RetentionAbandonReport {
  const at = deps.at ?? (() => { /* production does nothing here */ });
  const writeJournal = deps.journalWriter ?? writeRetentionJournal;
  const clearJournal = deps.journalClearer ?? clearRetentionJournal;
  const root = resolveMaintenanceRoot(projectRoot, 'project directory');

  const locks = MaintenanceLocks.open(root);
  try {
    // THE JOURNAL IS READ UNDER THE LOCK, and it is where the destination comes from. Because it records the
    // destination RELATIVE to the project this file is in, there is no chicken-and-egg here: the project
    // root is known before any read, and everything else is expressed against it.
    const opening = readRetentionJournal(root);
    if (opening === null) {
      throw new MaintenanceRefused('there is no interrupted retention run in this project to abandon');
    }
    const resolved = resolveRetentionDestination(root, opening.destination);
    const destinationDir = resolved.destinationDir;
    const destinationName = resolved.destinationName;
    locks.lockDestination(resolved.destinationDir);

    let current: RetentionJournal = { ...opening, phase: 'abandoning' };
    const quarantine = quarantineDirName(current.suffix);
    const quarantineDir = join(destinationDir, quarantine);
    const byName = new Map(current.inventory.map((row) => [row.name, row]));
    const putBack: string[] = [];
    const goneForever: string[] = [];
    const unresolved: string[] = [];
    const notes: string[] = [];
    // AN ABANDON OF AN OPERATION THAT MOVED THINGS IS ALWAYS POST-EFFECT. Its own first write records the
    // decision to abandon; everything it does after that is on top of renames a previous process performed.
    let effected = current.entries.some((entry) => entry.state !== 'pending') || existsSync(quarantineDir);

    const finish = (): RetentionAbandonReport => {
      const retained = tryRemoveOwnedQuarantine(quarantineDir, current)
        ? null : describeRetained(quarantineDir, quarantine);
      // THE JOURNAL MAY BE CLEARED WHEN NO REVERSIBLE WORK REMAINS — and clearing it never turns loss into
      // success. A destination with sets that are gone is a destination with sets that are gone.
      const clearable = unresolved.length === 0 && retained === null;
      let journalCleared = false;
      if (clearable) {
        clearJournal(root);
        journalCleared = true;
      } else {
        notes.push('The journal was kept, because this abandon did not put everything back.');
      }
      if (goneForever.length > 0) {
        notes.push('These sets had already been deleted and a rename cannot bring them back. If one of them '
          + 'was the set you needed, the recovery is another backup, not this command. This is NOT a clean '
          + 'unwind and this command does not report it as one.');
      }
      notes.push('An abandon puts directories back. It restores no database and no keystore, because it never '
        + 'touched either: this command only ever moved and removed files in a backup destination.');
      notes.push('No command of any kind was issued.');
      const state: RetentionAbandonState = unresolved.length > 0 || retained !== null ? 'PARTIAL'
        : goneForever.length > 0 ? 'ABANDONED_WITH_LOSS' : 'ABANDONED';
      return {
        report: RETENTION_REPORT,
        version: RETENTION_VERSION,
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
          // THE SET IS GONE AND ITS NAME MAY NOT BE FREE. A deletion frees a name and a later backup can take
          // it, so an operator reading "gone forever" beside a directory that is plainly there deserves the
          // sentence that reconciles the two. Nothing is touched either way.
          if (existsSync(join(destinationDir, entry.name))) {
            notes.push(`${entry.name} was destroyed by this operation and something is at its name again. `
              + 'That is not the set this operation removed, and nothing here touched it.');
          }
          continue;
        }
        const source = join(quarantineDir, entry.name);
        const target = join(destinationDir, entry.name);
        const inQuarantine = existsSync(quarantineDir) && existsSync(source);
        if (!inQuarantine) {
          if (existsSync(target)) {
            // Never quarantined, or already put back by an interrupted abandon. Either way it belongs there.
            current = markEntry(current, entry.name, 'pending', null);
            writeJournal(root, current);
            continue;
          }
          // IN NEITHER PLACE, AND WHAT THAT MEANS DEPENDS ON WHAT THE JOURNAL SAYS. Recorded `deleting` and
          // absent from both: the removal landed and the record did not, so that set is GONE. Recorded
          // `pending`, `quarantined` or `failed` and absent from both: this operation never began removing
          // it, so its absence was not caused here. That is a question, not a conclusion.
          if (entry.state === 'deleting') {
            goneForever.push(entry.name);
            current = markEntry(current, entry.name, 'removed', null);
            writeJournal(root, current);
            continue;
          }
          unresolved.push(entry.name);
          continue;
        }
        if (entry.state === 'deleting') {
          // A tree that was being consumed may be truncated. Putting a partial set back under a name an
          // operator trusts is the exact failure the quarantine exists to prevent.
          unresolved.push(entry.name);
          notes.push(`${entry.name} was part way through being removed and may be incomplete. It was NOT put `
            + 'back under its own name, because a partial set under a trusted name is worse than none.');
          continue;
        }
        if (existsSync(target)) {
          // Something now holds the name this set came from. Putting it back would replace that.
          unresolved.push(entry.name);
          continue;
        }
        // THE SAME OWNERSHIP AND IDENTITY PROOFS AS A DELETE. Renaming a stranger's directory INTO an
        // operator's backup destination, under a set name, is its own kind of damage.
        try {
          requireQuarantineDirectory(destinationDir, current, at);
          proveSetIsPlanned(source, byName.get(entry.name)!);
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
        // below is what fails, the set IS back under its own name, and a report that omitted it would be
        // telling an operator to go looking for something that is already where they want it.
        putBack.push(entry.name);
        current = markEntry(current, entry.name, 'pending', null);
        writeJournal(root, current);
      }

      return finish();
    } catch (err) {
      if (!effected) throw err;
      // A WRITE OR A CLEAR FAILED AFTER A RENAME. The CLI's refusal path exits with the code that means
      // "refused before anything was moved", and a set has moved — so this carries the report instead.
      throw new RetentionAbandonFailed(
        `${safeReason(err)} `
        + '\nThis failure arrived AFTER this abandon had already moved a backup set. Read the report above: '
        + 'it names what was put back, what is gone for good, what is still out of place and what the '
        + 'retained directory holds.',
        finishAfterFailure());
    }

    function finishAfterFailure(): RetentionAbandonReport {
      const retained = existsSync(quarantineDir) ? describeRetained(quarantineDir, quarantine) : null;
      return {
        report: RETENTION_REPORT,
        version: RETENTION_VERSION,
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
  journal: RetentionJournal,
  name: string,
  state: RetentionEntryState,
  reason: string | null,
): RetentionJournal {
  return {
    ...journal,
    entries: journal.entries.map((entry) => (entry.name === name ? { name, state, reason } : entry)),
  };
}

// -----------------------------------------------------------------------------------------------------------
// Rendering. Set names, classes, dates, sizes, counts and closed reasons. Never a path.
// -----------------------------------------------------------------------------------------------------------

const CLASS_LABEL: Readonly<Record<SetClass, string>> = Object.freeze({
  VERIFIED: 'verified',
  UNVERIFIED: 'DOES NOT VERIFY',
  UNREADABLE: 'unreadable manifest',
  FOREIGN: 'not ours',
  RESERVED: 'in-flight artifact',
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

export function renderRetentionPlan(plan: RetentionPlan): string {
  const lines: string[] = [];
  lines.push(`Backup retention plan — ${plan.destinationName}`);
  lines.push(`  policy              keep-last ${plan.policy.keepLast}, min-age-days ${plan.policy.minAgeDays}, `
    + `include-unverified ${plan.policy.includeUnverified}, keep-minimum-restorable ${plan.policy.keepMinimumRestorable}`);
  lines.push('');
  const reasons = new Map(plan.decisions.map((decision) => [decision.name, decision]));
  lines.push('  what is in this destination:');
  for (const entry of plan.inventory) {
    const decision = reasons.get(entry.name)!;
    const verb = decision.decision === 'remove' ? 'REMOVE' : 'keep  ';
    lines.push(`    ${verb}  ${entry.name}`);
    lines.push(`            ${CLASS_LABEL[entry.setClass]}`
      + `${entry.schemaVersion === null ? '' : `, schema ${entry.schemaVersion}`}`
      + `${entry.takenAt === null ? ', no usable date' : `, taken ${entry.takenAt}`}`
      + `${entry.bytes === 0 ? '' : `, ${humanBytes(entry.bytes)}`}`);
    lines.push(`            ${decision.reason}`);
    if (entry.findings.length > 0) lines.push(`            findings: ${entry.findings.join(', ')}`);
  }
  lines.push('');
  lines.push(`  would remove        ${plan.removals.length === 0 ? 'nothing' : plan.removals.join(', ')}`);
  lines.push(`  freeing            ~${humanBytes(plan.bytesToRemove)} (what the manifests declare)`);
  lines.push(`  protected          ${plan.protectedRestorable ?? 'nothing — and that is refused'}`);
  lines.push(`  restorable left     ${plan.restorableRemaining}`);
  lines.push(`  wrote               ${plan.wrote}`);
  lines.push(`  commands issued     ${plan.commands}`);
  lines.push('');
  lines.push('  Removals happen OLDEST FIRST, and every set is renamed into a private quarantine directory');
  lines.push('  before it is deleted, so a set name in this destination always holds a whole set or nothing.');
  lines.push('');
  lines.push(`  digest: ${plan.digest}`);
  lines.push('  Run it with --confirm <digest>. The digest covers this whole list — every set, its date, its');
  lines.push('  verification and its decision — so a backup taken since you read this will refuse it.');
  return lines.join('\n');
}

export function renderRetention(report: RetentionReport): string {
  const lines: string[] = [];
  lines.push(`Backup retention — ${report.state}`);
  lines.push(`  destination         ${report.destinationName}`);
  lines.push(`  planned             ${report.planned.length === 0 ? 'nothing' : report.planned.join(', ')}`);
  lines.push(`  removed             ${report.removed.length === 0 ? 'nothing' : report.removed.join(', ')}`);
  lines.push(`  freed              ~${humanBytes(report.bytesRemoved)}`);
  lines.push(`  kept                ${report.kept}`);
  lines.push(`  protected set       ${report.protectedRestorable ?? '-'}`);
  lines.push(`  ...still verifies   ${report.protectedRestorableVerified ? 'YES' : 'NO'}`);
  lines.push(`  journal cleared     ${report.journalCleared}`);
  lines.push(`  commands issued     ${report.commands}`);
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

export function renderRetentionAbandon(report: RetentionAbandonReport): string {
  const lines: string[] = [];
  lines.push(`Backup retention abandoned — ${report.state}`);
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
export { DEFAULT_RETENTION_POLICY };
