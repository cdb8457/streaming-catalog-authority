import {
  BACKUP_COMPONENT_IDS,
  COMPONENT_ARTIFACT_NAMES,
  type BackupComponentId,
} from './backup-components.js';

// Phase 297 — where each component of a complete backup actually GOES, and how it gets there.
//
// WHAT WAS MISSING. Phase 256 answered "what is a complete backup" and Phase 277 answered "how is one taken".
// Nothing answered "where does each of the four land when you put it back", except a paragraph in a lifecycle
// document and four `restore` command strings in the component model that an operator typed by hand. Those
// strings are still there and are still what an operator does WITHOUT this command; this module is the same
// answer as a value, so the command and the document cannot drift apart the way the backup instructions did.
//
// -----------------------------------------------------------------------------------------------------
// THERE ARE ONLY THREE WAYS A COMPONENT CAN LAND, AND EVERY COMPONENT DECLARES WHICH.
// -----------------------------------------------------------------------------------------------------
//
//   * SWAP — a host directory beside the Compose project (the secrets, the promotion records, and the
//     keystore in sidecar custody). The set's copy is staged under a dot-prefixed name, the target is renamed
//     aside, and the staged copy is renamed into place.
//   * CONTAINER-COPY — a Docker volume the app owns (the keystore in inline custody). `compose cp` into a
//     volume that `down -v` has just emptied.
//   * REPLAY — the database, streamed into `psql` from this command's own descriptor.
//
// A COMPONENT ADDED TO THE MODEL HAS TO ANSWER THIS TABLE BEFORE IT COMPILES. `PLACEMENTS` is keyed by
// `BackupComponentId`, so a fifth component is a type error here rather than a silence in a restore.
//
// -----------------------------------------------------------------------------------------------------
// WHY A SWAP AND NEVER AN OVERWRITE, AND NEVER A MERGE.
// -----------------------------------------------------------------------------------------------------
//
// A keystore restored ON TOP OF another keystore holds the wrapped keys of two different moments, every one
// of them individually valid, and the installation that reads it starts, passes every check and reports
// itself healthy. That is the exact failure the keystore component exists to prevent, arriving through the
// restore instead of through the backup. So nothing here writes into a directory that already has contents:
// the target is renamed aside whole, and what is renamed aside is what `--abandon` puts back.

export type PlacementKind = 'swap' | 'container-copy' | 'replay';

/** Where the keystore is depends on how the operator deployed. Declared, never probed — as in Phase 277. */
export type CustodianTopology = 'inline' | 'sidecar';

export interface ComponentPlacement {
  readonly id: BackupComponentId;
  /** The artifact's name inside a set. `COMPONENT_ARTIFACT_NAMES`'s, never retyped. */
  readonly artifact: string;
  readonly kind: PlacementKind;
  /**
   * Whether a set that does not carry this component can still be restored.
   *
   * Only the promotion records are optional, and for the reason Phase 277 already gives: an empty records
   * folder is a correct and permanent state for most installations. Optional means "absent is not a refusal",
   * NOT "absent is not recorded" — an absent component is reported as absent.
   */
  readonly optional: boolean;
  /** What this placement establishes, in one sentence. Never a path and never an address. */
  readonly proves: string;
}

/**
 * The placement of every component, given a declared custody topology.
 *
 * THE KEYSTORE IS THE ONLY ONE THAT MOVES, and it moves because the two supported deployments genuinely put
 * it in two places: a Docker volume the app owns, or a directory the sidecar keeps its state in. Guessing
 * between them is how a restore puts key material somewhere nothing reads — an installation that starts and
 * decrypts nothing, which is indistinguishable from a correct erasure.
 */
export function placementsFor(custodian: CustodianTopology): readonly ComponentPlacement[] {
  return BACKUP_COMPONENT_IDS.map((id): ComponentPlacement => {
    const artifact = COMPONENT_ARTIFACT_NAMES[id];
    switch (id) {
      case 'database':
        return {
          id,
          artifact,
          kind: 'replay',
          optional: false,
          proves: 'every item, event and publish record this installation ever had is back in the database',
        };
      case 'keystore':
        return {
          id,
          artifact,
          kind: custodian === 'inline' ? 'container-copy' : 'swap',
          optional: false,
          proves: 'the wrapped data-encryption keys are where the custodian this installation runs will read them',
        };
      case 'secrets':
        return {
          id,
          artifact,
          kind: 'swap',
          optional: false,
          proves: 'the KEK, the completion secret and the database credentials are the ones the restored state needs',
        };
      case 'promotion-records':
        return {
          id,
          artifact,
          kind: 'swap',
          optional: true,
          proves: 'the operator\'s own chain artifacts are back in the folder the service reads them from',
        };
    }
  });
}

/** One placement, by id, for a declared topology. */
export function placementFor(custodian: CustodianTopology, id: BackupComponentId): ComponentPlacement {
  const found = placementsFor(custodian).find((placement) => placement.id === id);
  // Unreachable while `placementsFor` covers `BackupComponentId` exhaustively, which the compiler enforces.
  if (found === undefined) throw new Error(`no restore placement for ${id}`);
  return found;
}

/**
 * The components a restore MUST find in the set, for a declared topology.
 *
 * Derived from `optional`, so it cannot disagree with the table above.
 */
export function requiredPlacementIds(custodian: CustodianTopology): readonly BackupComponentId[] {
  return placementsFor(custodian).filter((placement) => !placement.optional).map((placement) => placement.id);
}

// -----------------------------------------------------------------------------------------------------------
// The steps
// -----------------------------------------------------------------------------------------------------------

/**
 * Every step a restore performs, in order, as ids.
 *
 * THIS IS THE ONLY ORDER THAT EXISTS. `--plan` renders it, the digest binds it, the journal records it and
 * `--resume` walks it. Phase 279's rehearsal was built the same way after its printed plan and its executed
 * sequence came to disagree about something as large as which image booted.
 *
 * THE ORDER IS THE GUARANTEE, and two places in it are load-bearing:
 *
 *   * `stop-and-destroy` IS THE IRREVERSIBLE STEP, and everything that can refuse happens before it. A
 *     restore that refuses has changed nothing; a restore that has passed this point has a safety set behind
 *     it or an explicit acknowledgement that there is none.
 *   * `place-secrets` COMES BEFORE `database-up`. PostgreSQL initialises a fresh volume with the password in
 *     the secret file it is given, so placing the set's secrets first is what makes the restored
 *     `postgres_password` the password the volume actually has. Restoring secrets after a database had
 *     already been initialised is the caveat `backup-components.ts` has always carried, closed by ordering
 *     rather than by a warning nobody reads at 3am.
 */
export const RESTORE_STEP_IDS = [
  'safety-set',
  // PHASE 304 CORRECTION. The set was verified once, and then every later step RE-OPENED it by path: a
  // `copyTree` walked the component directories again and the replay bound a descriptor to the dump again.
  // A set that changed in between — by an operator tidying up, by a second process, or by anything hostile
  // holding a handle on that directory — supplied DIFFERENT BYTES to the restore than the ones the
  // verification approved, and nothing would have noticed. Every component is now staged first, through
  // descriptor-safe reads, and the STAGED object is re-verified against the manifest's own recorded digest,
  // entry count and byte count before anything is placed. What is restored is what was verified.
  'stage-components',
  'stop-and-destroy',
  'place-secrets',
  'place-promotion-records',
  'place-sidecar-keystore',
  'database-up',
  'prepare-runtime-role',
  'replay-database',
  'place-inline-keystore',
  'stack-up',
  'prove-version',
  'prove-doctor',
  'prove-decrypt',
  'prove-history',
] as const;

export type RestoreStepId = (typeof RESTORE_STEP_IDS)[number];

/**
 * The steps that have destroyed something by the time they complete.
 *
 * A journal recording one of these as started-and-not-completed is what makes `--abandon` a different
 * operation from "run it again": the installation is not where it was, and pretending otherwise would have
 * the next run take a "safety set" of the wreckage.
 */
export const DESTRUCTIVE_STEP_IDS: readonly RestoreStepId[] = Object.freeze([
  'stop-and-destroy', 'place-secrets', 'place-promotion-records', 'place-sidecar-keystore', 'replay-database',
  'place-inline-keystore',
]);

/**
 * The steps that only ESTABLISH something, and change nothing when they are run a second time.
 *
 * They are the ones that may fail and let the run CONTINUE: a failed version check must not hide whether the
 * installation can decrypt, because those are different problems with different answers. That is why the
 * journal cannot be an ordered list of completed steps — see `JournalStep`.
 */
export const PROOF_STEP_IDS: readonly RestoreStepId[] = Object.freeze([
  'prove-version', 'prove-doctor', 'prove-decrypt', 'prove-history',
]);

// -----------------------------------------------------------------------------------------------------------
// What a step needs when the process died in the middle of it
// -----------------------------------------------------------------------------------------------------------

/**
 * How a resume recovers a step the journal records as RUNNING.
 *
 * -----------------------------------------------------------------------------------------------------
 * "RUNNING" IS THE ONE STATE A CRASH CAN LEAVE, AND IT IS NOT THE SAME QUESTION FOR EVERY STEP.
 * -----------------------------------------------------------------------------------------------------
 *
 * The journal records a step as running BEFORE its effect and complete AFTER it. A process that dies in
 * between — a kill, a runtime crash, an interrupt — leaves exactly one step running, and the effect either landed,
 * landed partly, or did not land. What a resume may safely do about that depends entirely on which step it
 * is, and the first cut of this tranche had one answer for all of them ("run it again"), which is right for
 * most and catastrophic for two.
 *
 * So each step DECLARES its policy, and the recovery is dispatched on the declaration rather than on a
 * reviewer remembering which steps are idempotent:
 *
 *   * `retry` — running it again from the top is indistinguishable from running it once. `compose down -v`
 *     on an already-destroyed stack, an `up` on a running one, a staging directory that is removed and
 *     rebuilt, a read-only proof. Most steps are this, and saying so is what makes the other three visible.
 *
 *   * `confirm-or-retry` — the effect PUBLISHES SOMETHING UNDER A NAME, and repeating it blindly would be
 *     refused by the very guard that protects it. The safety set is this: `ops:complete-backup` refuses an
 *     existing set name, so a crash after the set was published but before the journal was updated would
 *     leave a resume permanently unable to get past its first step. The recovery LOOKS FIRST: a set that is
 *     there and verifies is the safety set this run took, and the step is complete.
 *
 *   * `repair-swap` — the effect is TWO RENAMES, and a crash between them leaves the target missing, the
 *     previous contents under `.replaced-` and the new contents under `.restoring-`. That is not a state to
 *     re-run into: re-running would find no target, copy the staged component to a staging name that already
 *     exists, and refuse. The recovery finishes the interrupted rename, which is the only outcome that
 *     leaves the installation somewhere describable.
 *
 *   * `rewind` — the effect is NOT idempotent and NOT repairable. A `psql` replay killed halfway leaves a
 *     partial schema; replaying the same dump over it produces conflicts, not a restore. There is exactly
 *     one safe recovery and it is to go back to the teardown and do the whole database leg again. The step
 *     names where to rewind to, so the journal's own state is rewritten rather than a human reasoning about
 *     which earlier steps have been invalidated.
 */
export type RecoveryPolicy = 'retry' | 'confirm-or-retry' | 'repair-swap' | 'rewind';

export const STEP_RECOVERY: Readonly<Record<RestoreStepId, RecoveryPolicy>> = Object.freeze({
  // Publishes a named set; an existing name is refused, so a blind retry would wedge the resume.
  'safety-set': 'confirm-or-retry',
  // Removes whatever partial staging it finds and rebuilds from the set, re-verifying against the manifest.
  'stage-components': 'retry',
  'stop-and-destroy': 'retry',
  'place-secrets': 'repair-swap',
  'place-promotion-records': 'repair-swap',
  'place-sidecar-keystore': 'repair-swap',
  'database-up': 'retry',
  // `CREATE ROLE IF NOT EXISTS` in one statement.
  'prepare-runtime-role': 'retry',
  // A PARTIAL REPLAY IS THE ONE STATE NOTHING CAN REPAIR IN PLACE.
  'replay-database': 'rewind',
  // Copies the staged, verified tree into a volume the teardown emptied; a second copy of the same bytes
  // over a partial one leaves the same tree.
  'place-inline-keystore': 'retry',
  'stack-up': 'retry',
  'prove-version': 'retry',
  'prove-doctor': 'retry',
  'prove-decrypt': 'retry',
  'prove-history': 'retry',
});

/**
 * Where a `rewind` step goes back to.
 *
 * The database leg is one unit: destroy the volumes, start a fresh database, prepare the role, replay. A
 * replay interrupted anywhere inside it invalidates the whole leg, and the honest recovery is to run the leg
 * again rather than to guess how much of the dump landed.
 */
export const STEP_REWIND_TO: Readonly<Partial<Record<RestoreStepId, RestoreStepId>>> = Object.freeze({
  'replay-database': 'stop-and-destroy',
});

/** What each step establishes. Rendered by `--plan`, and never interpolated with anything read at runtime. */
export const RESTORE_STEP_PURPOSE: Readonly<Record<RestoreStepId, string>> = Object.freeze({
  'safety-set': 'a verified complete backup of the installation this restore is about to destroy',
  'stage-components': 'every component is copied out of the set and RE-VERIFIED against the manifest, so what '
    + 'is restored is exactly what was verified rather than whatever is at those paths later',
  'stop-and-destroy': 'the stack is stopped and its volumes destroyed, so the dump replays into an EMPTY database',
  'place-secrets': 'the set\'s secret files are in place BEFORE a fresh database volume is initialised from them',
  'place-promotion-records': 'the set\'s promotion record artifacts are back in the folder the service reads',
  'place-sidecar-keystore': 'the set\'s keystore is in the sidecar state directory the operator named',
  'database-up': 'a fresh database is running and healthy, from an image already on this host',
  'prepare-runtime-role': 'the managed runtime role exists without a login before the dump replays its grants',
  'replay-database': 'the verified dump is replayed from this command\'s own descriptor, stopping on any error',
  'place-inline-keystore': 'the set\'s keystore is in the app volume that the teardown emptied',
  'stack-up': 'the whole stack starts, migrates idempotently and provisions the restored runtime credential',
  'prove-version': 'the running build and the restored database agree on the schema version the set recorded',
  'prove-doctor': 'the shipped read-only doctor reports no failure, and its BODY is read rather than its exit code',
  'prove-decrypt': 'the installation reads and DECRYPTS its own catalog — the proof the keystore actually arrived',
  'prove-history': 'the durable, identity-minimised import and collection history survived the replay',
});

/**
 * Which steps a run of this shape performs.
 *
 * A step that does not apply is ABSENT from the plan rather than present and skipped: a plan an operator
 * reads must not list an operation that will not happen, and the digest binds the list, so a run whose shape
 * changed cannot be confirmed with a digest computed for the other one.
 */
export function stepsFor(options: {
  readonly custodian: CustodianTopology;
  readonly safetySet: boolean;
  readonly promotionRecords: boolean;
}): readonly RestoreStepId[] {
  return RESTORE_STEP_IDS.filter((id) => {
    if (id === 'safety-set') return options.safetySet;
    if (id === 'place-promotion-records') return options.promotionRecords;
    if (id === 'place-sidecar-keystore') return options.custodian === 'sidecar';
    if (id === 'place-inline-keystore') return options.custodian === 'inline';
    return true;
  });
}

/**
 * The token a plan uses where the run's private staging directory will be.
 *
 * THE PLAN DIGEST MUST NOT DEPEND ON THE RUN. The staging directory carries a per-run suffix, so putting its
 * real path into a planned command would give every plan of the same operation a different digest — and a
 * digest an operator can never reproduce is a confirmation that confirms nothing. The plan therefore binds
 * this token, and the run substitutes the directory it created. Both the guard and the display see the token.
 */
export const STAGED_TOKEN = '<staged>';

/** Where the verified copy of one component sits inside the staging directory, as the plan spells it. */
export function stagedPath(relative: string): string {
  return `${STAGED_TOKEN}/${relative}`;
}

/** The private directory one run stages its verified components in, inside the project. */
export function stagingDirName(suffix: string): string {
  return `.catalog-restore.staged-${suffix}`;
}

/**
 * The suffix shape a journal may carry.
 *
 * IT IS VALIDATED BECAUSE IT IS CONCATENATED INTO FILE NAMES. A journal is a file on disk that a later run
 * reads and builds `.secrets.replaced-<suffix>` out of; a suffix carrying a separator, a traversal or a NUL
 * would make that name point somewhere nobody chose. `stagingSuffix()` produces exactly twelve lowercase hex
 * characters, and nothing else is accepted.
 */
export const RESTORE_SUFFIX_RE = /^[0-9a-f]{12}$/;

/** The staging name a swap uses beside its target. Dot-prefixed, so a killed run leaves something ignorable. */
export function swapStagingName(target: string, suffix: string): string {
  return `.${target}.restoring-${suffix}`;
}

/** The name the PREVIOUS contents of a swapped target are renamed to. What `--abandon` puts back. */
export function swapReplacedName(target: string, suffix: string): string {
  return `.${target}.replaced-${suffix}`;
}
