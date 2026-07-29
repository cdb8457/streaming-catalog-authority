import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FileCustodian } from '../core/crypto/file-custodian.js';
import {
  KEK_RING_DIRNAME,
  KekRingError,
  activatePendingGeneration,
  activeKek,
  beginPendingGeneration,
  decodeKey,
  kekForGeneration,
  loadKekRing,
  readRootWrappingKey,
  retireGeneration,
  rootKeyId,
  rotateRootWrappingKey,
  summarizeKekRing,
  type KekRingSummary,
} from '../core/crypto/kek-ring.js';
import { readStateDocument, writeStateDocument } from '../core/crypto/custodian-state-io.js';
import { verifyBackupSet } from './backup-set-verification.js';
import {
  CommandLedger,
  MaintenanceRefused,
  acquireLockDirectory,
  resolveMaintenanceRoot,
  runGuarded,
  type CommandRunner,
  type MaintenanceCommand,
} from './maintenance-safety.js';

// Phase 283 — rotating a KEK without a window in which the catalog is unreadable.
//
// -----------------------------------------------------------------------------------------------------
// WHY THIS IS NOT "GENERATE A NEW KEY AND RE-ENCRYPT".
// -----------------------------------------------------------------------------------------------------
//
// Rewrapping a keystore is the easy part and it was already implemented. What makes a rotation dangerous is
// everything around it:
//
//   * IT TOUCHES EVERY KEY IN THE INSTALLATION. A failure part-way leaves some wrapped DEKs under the old KEK
//     and some under the new one. If the ring has already moved on, the ones left behind are unreadable — and
//     an unreadable item is indistinguishable from a correctly erased one, so nothing reports it.
//   * A CRASH IS NOT A HYPOTHETICAL. This runs on a NAS, against a share, on a schedule an operator set. The
//     question is not whether it will be interrupted but what state it leaves when it is.
//   * THE OLD KEY IS STILL NEEDED AFTERWARDS. Every backup taken before this moment holds DEKs under the
//     OUTGOING generation. A rotation that forgot it the instant the new one activated would silently make
//     every existing backup unrestorable — the failure would surface on the day somebody restored one.
//
// So the order is fixed, each step is durable before the next begins, and NOTHING becomes authoritative until
// everything has been verified:
//
//   1. PLAN AND CONFIRM. A digest over what would happen; nothing runs without it echoed back.
//   2. THE LOCK. One maintenance command at a time over this state directory.
//   3. A COMPLETE BACKUP THAT VERIFIES NOW. Not one that exists — one that verifies, before a byte moves.
//   4. QUIESCE. The app and the sidecar are stopped, because the keystore is single-writer and a rotation is
//      a writer.
//   5. A PENDING GENERATION, generated inside the sidecar's own ring. Pending means nothing is under it yet.
//   6. A JOURNAL, written before the first key file changes, naming the plan and the two generations.
//   7. PER-KEY ATOMIC REWRAP, resumable and idempotent: each file is wholly old or wholly new, and a file
//      already readable under the pending generation is skipped.
//   8. VERIFY ALL, then ACTIVATE. Every live key must unwrap under the pending generation before the ring
//      moves. A single failure leaves the ring untouched, which leaves the installation exactly as it was.
//   9. THE OUTGOING GENERATION IS RETAINED. It is removed only by an explicit, separate retirement, gated on
//      a POST-rotation backup that verifies.
//
// A crash at any point resumes: the journal says which stage was reached, the rewrap is idempotent, and a
// ring that never activated is a ring whose active generation is still what the key files are under.

export const KEK_ROTATION_REPORT = 'phase-283-kek-rotation';
export const KEK_ROTATION_VERSION = 1;

export const ROTATION_JOURNAL_NAME = 'rotation-journal.json';
export const ROTATION_LOCK_DIRNAME = '.catalog-kek-rotation.lock';

/** The stages, in order. A journal names the last one that COMPLETED. */
export type RotationStage = 'claimed' | 'pending-created' | 'rewrapped' | 'verified' | 'activated';

export const ROTATION_STAGES: readonly RotationStage[] = Object.freeze([
  'claimed', 'pending-created', 'rewrapped', 'verified', 'activated',
]);

export interface RotationJournal {
  readonly rotation: typeof KEK_ROTATION_REPORT;
  readonly version: typeof KEK_ROTATION_VERSION;
  readonly planDigest: string;
  readonly fromGeneration: number;
  readonly toGeneration: number | null;
  readonly stage: RotationStage;
  readonly startedAt: number;
}

export interface KekRotationRequest {
  /** The sidecar's state directory, absolute. Holds the ring and the keystore. */
  readonly stateDir: string;
  /** The root wrapping key file. Read ONLY here and only from a private file; never an argument. */
  readonly rootKeyFile: string;
  /** A complete backup set that must verify before anything moves. */
  readonly backupSet: string;
  /** The Compose project directory, for the quiesce. Never written. */
  readonly projectRoot: string;
  /** The Compose project name, so the quiesce addresses one stack explicitly. */
  readonly projectName: string;
}

export interface ResolvedKekRotation extends KekRotationRequest {
  readonly planDigest: string;
  /** A non-reversible label for the root key sealing the ring. Proves WHICH without naming it. */
  readonly rootKeyId: string;
  readonly fromGeneration: number;
  /**
   * The verified set's OWN digest, not the path it was found at.
   *
   * A path is a promise about where a set is, not about what it is. A retention schedule writing a new set
   * over the same name between the plan and the run would otherwise satisfy every check while being a
   * different set — and the set is the only thing this rotation could fall back to.
   */
  readonly backupSetDigest: string;
}

export interface KekRotationReport {
  readonly report: typeof KEK_ROTATION_REPORT;
  readonly version: typeof KEK_ROTATION_VERSION;
  readonly ok: boolean;
  readonly planDigest: string;
  /** Which stage this run reached. A closed word; the same vocabulary the journal uses. */
  readonly stage: RotationStage | 'not-started';
  readonly fromGeneration: number;
  readonly toGeneration: number | null;
  /** How many wrapped keys were moved, skipped (already current) and seen. Counts, never ids. */
  readonly keys: { readonly rewrapped: number; readonly skipped: number; readonly total: number };
  /** Whether every live key was proved readable under the new generation BEFORE the ring moved. */
  readonly verifiedAll: boolean;
  readonly ring: KekRingSummary | null;
  readonly backupVerified: boolean;
  readonly quiesced: readonly string[];
  readonly restarted: boolean;
  /** Services stopped for the rotation that did not start again. An outage is a named fact. */
  readonly stillStopped: readonly string[];
  readonly network: 'none';
  readonly notes: readonly string[];
}

export interface KekRotationDeps {
  readonly runner: CommandRunner;
  readonly ledger: CommandLedger;
  readonly now?: () => number;
}

/** The services that must not be writing while every wrapped key in the installation is rewritten. */
export const ROTATION_QUIESCED_SERVICES: readonly string[] = Object.freeze(['app', 'sidecar']);

/**
 * Validate a rotation into resolved paths and a digest, touching nothing.
 *
 * IT READS THE RING. That is deliberate: the digest an operator confirms binds the generation they are
 * rotating AWAY from, so a plan read at one moment cannot be spent on a ring that has since moved.
 */
export function planKekRotation(request: KekRotationRequest): ResolvedKekRotation {
  const stateDir = resolveMaintenanceRoot(request.stateDir, 'sidecar state directory');
  const projectRoot = resolveMaintenanceRoot(request.projectRoot, 'Compose project root');
  const backupSet = resolveMaintenanceRoot(request.backupSet, 'backup set directory');
  if (request.projectName.trim() === '') throw new MaintenanceRefused('the Compose project name was not given');

  const verification = verifyBackupSet(backupSet);
  if (!verification.ok || verification.setDigest === '') {
    throw new MaintenanceRefused(
      'the complete backup this rotation would fall back to does not verify. A rotation rewrites every wrapped '
      + 'key in the installation; without a set that verifies NOW there is nothing to go back to. Nothing was '
      + 'changed.');
  }
  const root = readRootWrappingKey(request.rootKeyFile);
  const ring = loadKekRing(stateDir, root);
  const journal = readRotationJournal(stateDir);
  if (ring.pending !== null && journal === null) {
    throw new KekRingError(
      'this ring has a pending generation and no rotation journal. That is a rotation somebody interrupted '
      + 'and then removed the record of. Refused: this build will not guess which keys are under which '
      + 'generation.');
  }
  const resolved = {
    stateDir,
    rootKeyFile: request.rootKeyFile,
    backupSet,
    projectRoot,
    projectName: request.projectName.trim(),
    rootKeyId: rootKeyId(root),
    // A RESUME IS THE SAME DECISION CONTINUED, so it carries the SAME digest. The generation being rotated
    // away from therefore comes from the JOURNAL where there is one — the ring's own active pointer has
    // already moved if the interruption happened after activation, and recomputing from it would produce a
    // digest the operator was never shown and hand them a fresh confirmation for work already half done.
    fromGeneration: journal === null ? ring.active : journal.fromGeneration,
    backupSetDigest: verification.setDigest,
  };
  return { ...resolved, planDigest: kekRotationPlanDigest(resolved) };
}

/**
 * The digest an operator confirms.
 *
 * Over WHERE, WHICH ROOT, and WHICH GENERATION — the three things that decide what a rotation would do. The
 * paths are digested rather than named, so the value carries no host layout; the root is already a
 * non-reversible label.
 */
export function kekRotationPlanDigest(plan: Omit<ResolvedKekRotation, 'planDigest'>): string {
  return createHash('sha256').update(JSON.stringify({
    report: KEK_ROTATION_REPORT,
    version: KEK_ROTATION_VERSION,
    stateDir: createHash('sha256').update(plan.stateDir, 'utf8').digest('hex'),
    backupSet: createHash('sha256').update(plan.backupSet, 'utf8').digest('hex'),
    projectName: plan.projectName,
    rootKeyId: plan.rootKeyId,
    fromGeneration: plan.fromGeneration,
    backupSetDigest: plan.backupSetDigest,
  }), 'utf8').digest('hex');
}

/**
 * A rotation that failed AND left services stopped.
 *
 * THE SAME RULE AS THE BACKUP'S. Two facts, and the urgent one is the outage — a refusal about why a rotation
 * did not run is the smaller problem beside an installation that is down. The primary refusal is preserved
 * word for word; a foreign error never lends its message, because only this product's own refusals are safe to
 * repeat and a runtime's routinely carries a path.
 */
export class KekRotationFailed extends MaintenanceRefused {
  readonly primary: string;
  readonly stillStopped: readonly string[];

  constructor(primary: string, stillStopped: readonly string[]) {
    super(`${primary} AND THE STACK IS STILL DOWN: this command stopped ${stillStopped.length} service(s) for `
      + 'the rotation and could not start them again. START THEM BEFORE ANYTHING ELSE — the failure above is '
      + 'the smaller of these two problems.');
    this.name = 'KekRotationFailed';
    this.primary = primary;
    this.stillStopped = [...stillStopped];
  }
}

function withOutage(err: unknown, stillStopped: readonly string[]): unknown {
  if (stillStopped.length === 0) return err;
  const primary = err instanceof MaintenanceRefused || err instanceof KekRingError
    ? err.message
    : 'the rotation could not be carried out, for a reason this command does not have safe wording for.';
  return new KekRotationFailed(primary, stillStopped);
}

/**
 * Decide which stage a resumed rotation may actually start from, by looking at the RING and the KEYSTORE.
 *
 * A JOURNAL IS A CLAIM. It is a file in a directory an operator can open, a restore can write and a failed
 * disk can half-write. Trusting `verified` skips the one check that makes activation safe — proving every
 * live key reads under the new generation — and trusting `activated` skips proving the ring moved at all. So
 * each stage is re-established from what is on disk, and the answer is the EARLIEST stage the evidence
 * supports. Re-doing a completed step is free (every one is idempotent); skipping an incomplete one is not.
 */
function reconcileJournalStage(
  resolved: ResolvedKekRotation,
  root: Buffer,
  journal: RotationJournal,
): RotationStage {
  const ring = loadKekRing(resolved.stateDir, root);
  const to = journal.toGeneration;
  // No pending generation was ever created, whatever the journal says.
  if (to === null || !ring.generations.some((entry) => entry.generation === to)) return 'claimed';
  // The ring has already moved: that is the only stage whose evidence is the ring itself.
  if (ring.active === to) {
    const underNew = everyKeyOpensUnder(resolved.stateDir, kekForGeneration(ring, to));
    return underNew ? 'activated' : 'rewrapped';
  }
  // The ring has not moved, so the most the evidence can support is that the keys were rewrapped — and
  // `verified` is never taken on trust, because re-verifying is exactly what it claims was done.
  const rewrapped = everyKeyOpensUnder(resolved.stateDir, kekForGeneration(ring, to));
  return rewrapped ? 'rewrapped' : 'pending-created';
}

/** Does every live wrapped key open under this key? The question `verified` and `activated` both rest on. */
function everyKeyOpensUnder(stateDir: string, kek: Buffer): boolean {
  try {
    const plan = FileCustodian.planRewrapKeystore(stateDir, { fromKek: kek, toKek: kek });
    return plan.total > 0 && plan.alreadyCurrent === plan.total;
  } catch {
    return false;
  }
}

export function rotationJournalPath(stateDir: string): string {
  return join(stateDir, KEK_RING_DIRNAME, ROTATION_JOURNAL_NAME);
}

export function readRotationJournal(stateDir: string): RotationJournal | null {
  const journal = readStateDocument<RotationJournal>(rotationJournalPath(stateDir));
  if (journal === null) return null;
  // CLOSED AND BOUNDED. Every field checked, no field absent, and NO FIELD THIS BUILD DOES NOT DECLARE — a
  // journal is a file in a directory an operator can open, and one carrying an unexpected key was written by
  // something that does not know this contract.
  const declared = ['rotation', 'version', 'planDigest', 'fromGeneration', 'toGeneration', 'stage', 'startedAt'];
  for (const key of Object.keys(journal as unknown as Record<string, unknown>)) {
    if (!declared.includes(key)) throw new KekRingError('the rotation journal carries a field this build does not know');
  }
  if (journal.rotation !== KEK_ROTATION_REPORT || journal.version !== KEK_ROTATION_VERSION
    || typeof journal.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(journal.planDigest)
    || !ROTATION_STAGES.includes(journal.stage)
    || !Number.isInteger(journal.fromGeneration) || journal.fromGeneration < 1
    || (journal.toGeneration !== null && (!Number.isInteger(journal.toGeneration) || journal.toGeneration < 1))
    || !Number.isInteger(journal.startedAt) || journal.startedAt < 1) {
    throw new KekRingError('the rotation journal is not one this build wrote');
  }
  return journal;
}

/**
 * Rotate, or resume a rotation, or refuse.
 *
 * `confirmDigest` gates the whole thing. A resume carries the SAME digest the interrupted run did, so
 * resuming is not a second decision an operator makes blind — it is the same decision, continued.
 */
export function runKekRotation(
  request: KekRotationRequest & { readonly confirmDigest: string | null },
  deps: KekRotationDeps,
): KekRotationReport {
  const resolved = planKekRotation(request);
  const now = deps.now ?? (() => Date.now());
  if (request.confirmDigest !== resolved.planDigest) {
    throw new MaintenanceRefused(
      'the digest you confirmed is not the digest of the rotation this command just computed. Nothing was '
      + 'changed. Run with --plan, read it, and copy the digest from the plan you actually read.');
  }

  // The backup was verified by `planKekRotation` above, and is verified AGAIN under the lock below.

  const lock = acquireLockDirectory(join(resolved.stateDir, ROTATION_LOCK_DIRNAME),
    'another KEK rotation is already running against this sidecar state, or one was interrupted and left its '
    + 'lock behind. Two rotations over one keystore is two writers.');

  const notes: string[] = [];
  const quiesced: string[] = [];
  const stillStopped: string[] = [];
  let stage: RotationStage | 'not-started' = 'not-started';
  let keys = { rewrapped: 0, skipped: 0, total: 0 };
  let verifiedAll = false;
  let toGeneration: number | null = null;
  let restarted = false;

  /** Start again everything this run stopped, recording what would not come back. Never throws. */
  const restartQuiesced = (): void => {
    if (restarted) return;
    restarted = true;
    for (const service of [...quiesced].reverse()) {
      try {
        const start = runGuarded(deps.runner, deps.ledger, composeCommand(resolved, ['start', service],
          `start ${service} again`));
        if (start.status !== 0) throw new MaintenanceRefused('non-zero exit');
      } catch {
        stillStopped.push(service);
        notes.push(`The ${service} service did not start again. Start it before anything else: this command `
          + 'has finished and the stack is down.');
      }
    }
  };

  try {
    // ---- RE-RESOLVED UNDER THE LOCK ----------------------------------------------------------------------
    //
    // THE WINDOW THIS CLOSES. Everything above happened before the lock: the ring was read, the backup was
    // verified, the digest was computed and compared. Between that and here, another process holding no lock
    // could have rotated the ring, replaced the backup at the same path, or swapped the root key file. The
    // plan digest binds the ring's generation, the root's label and the SET'S OWN DIGEST, so recomputing it
    // here — inside the lock, from what is on disk now — is what makes the comparison mean anything.
    const underLock = planKekRotation(request);
    if (underLock.planDigest !== resolved.planDigest) {
      throw new MaintenanceRefused(
        'the ring, the root key or the backup set changed between reading this plan and taking the lock. '
        + 'Nothing was changed and nothing was stopped. Re-run with --plan against what is actually there.');
    }
    const afterLock = verifyBackupSet(resolved.backupSet);
    if (!afterLock.ok || afterLock.setDigest !== resolved.backupSetDigest) {
      throw new MaintenanceRefused(
        'the complete backup this rotation would fall back to is not the one the plan was computed against — a '
        + 'set at that path verifies and it is a different set. Nothing was changed and nothing was stopped.');
    }

    const root = readRootWrappingKey(resolved.rootKeyFile);
    const journal = readRotationJournal(resolved.stateDir);
    if (journal !== null && journal.planDigest !== resolved.planDigest) {
      throw new MaintenanceRefused(
        'a rotation journal from a DIFFERENT rotation is in this state directory. Finish or abandon that one '
        + 'deliberately; this command will not run a second rotation across a half-moved keystore.');
    }
    if (journal !== null) {
      notes.push('A rotation journal was found, so this run RESUMED an interrupted rotation rather than '
        + 'starting one. Every step below is idempotent, so a resumed run repeats only what did not finish.');
      // A JOURNAL STAGE IS A CLAIM, NOT A FACT. It is reconciled against the ring and the keystore below,
      // because a forged or stale journal saying "verified" would otherwise skip the one check that makes
      // activation safe.
      stage = reconcileJournalStage(resolved, root, journal);
      toGeneration = journal.toGeneration;
      if (stage !== journal.stage) {
        notes.push('The journal claimed a later stage than the ring and the keystore actually show, so this '
          + 'run resumed from what is TRUE on disk rather than from what the journal said.');
      }
    }

    try {
      // ---- QUIESCE, INSIDE THE BLOCK WHOSE `finally` RESTARTS ------------------------------------------
      //
      // THE DEFECT THIS CLOSES. The quiesce loop used to sit OUTSIDE this `try`. Stopping `app` succeeded,
      // stopping `sidecar` failed, the loop threw — and the `finally` that starts services again was never
      // entered, so the app was left stopped by a command that had changed nothing and reported a refusal
      // about the sidecar. An operator was told a rotation did not start; they were not told their
      // installation was down.
      for (const service of ROTATION_QUIESCED_SERVICES) {
        const stop = runGuarded(deps.runner, deps.ledger, composeCommand(resolved, ['stop', service],
          `stop ${service} so nothing writes while every wrapped key is rewritten`));
        if (stop.status !== 0) {
          throw new MaintenanceRefused(
            `the ${service} service could not be stopped, so a rotation would run against a live writer. `
            + 'Nothing was changed.');
        }
        quiesced.push(service);
      }

      // ---- STAGE 1: the journal, before anything moves --------------------------------------------------
      if (stage === 'not-started') {
        writeJournal(resolved, { stage: 'claimed', fromGeneration: resolved.fromGeneration, toGeneration: null, startedAt: now() });
        stage = 'claimed';
      }

      // ---- STAGE 2: a pending generation, generated inside the ring -------------------------------------
      const ring = loadKekRing(resolved.stateDir, root);
      if (stage === 'claimed') {
        const started = ring.pending === null
          ? beginPendingGeneration(resolved.stateDir, root, now)
          : { ring, generation: ring.pending };
        toGeneration = started.generation;
        writeJournal(resolved, { stage: 'pending-created', fromGeneration: resolved.fromGeneration, toGeneration, startedAt: now() });
        stage = 'pending-created';
      }
      const current = loadKekRing(resolved.stateDir, root);
      toGeneration = toGeneration ?? current.pending;
      if (toGeneration === null) throw new KekRingError('the rotation reached the rewrap with no pending generation');

      const fromKek = kekForGeneration(current, resolved.fromGeneration);
      const toKek = kekForGeneration(current, toGeneration);

      // ---- STAGE 3: per-key atomic rewrap, resumable and idempotent -------------------------------------
      if (stage === 'pending-created') {
        try {
          keys = FileCustodian.rewrapKeystore(resolved.stateDir, { fromKek, toKek });
        } catch {
          // A CLOSED SENTENCE, AND THE RING UNMOVED. The rewrap's own message names a condition of the
          // keystore; what an operator needs here is what state they are in, which is the same one they were
          // in before this ran.
          throw new MaintenanceRefused(
            'a wrapped key in this keystore does not open under the generation this rotation is moving away '
            + 'from, so it cannot be moved. The ring was NOT changed and this installation is exactly as it '
            + 'was. That key was written by something other than this custodian, or the keystore is damaged: '
            + 'restore the sidecar state from a verified complete backup before rotating.');
        }
        writeJournal(resolved, { stage: 'rewrapped', fromGeneration: resolved.fromGeneration, toGeneration, startedAt: now() });
        stage = 'rewrapped';
      }

      // ---- STAGE 4: VERIFY ALL, before the ring moves ---------------------------------------------------
      //
      // THE STEP THAT MAKES THE REST SAFE. A rewrap that reported success and left one file behind would
      // otherwise be discovered on the day somebody read that item — and by then the ring has moved. Every
      // live key is proved readable under the NEW generation while the OLD one is still active, so a failure
      // here leaves an installation that is exactly as it was.
      if (stage === 'rewrapped') {
        let plan;
        try {
          plan = FileCustodian.planRewrapKeystore(resolved.stateDir, { fromKek: toKek, toKek });
        } catch {
          plan = null;
        }
        if (plan === null || plan.needsRewrap !== 0 || plan.alreadyCurrent !== plan.total) {
          throw new MaintenanceRefused(
            'not every wrapped key reads under the new generation after the rewrap. The ring was NOT moved, so '
            + 'this installation is exactly as it was. Re-run to resume; the rewrap is idempotent.');
        }
        verifiedAll = true;
        keys = { ...keys, total: plan.total };
        writeJournal(resolved, { stage: 'verified', fromGeneration: resolved.fromGeneration, toGeneration, startedAt: now() });
        stage = 'verified';
      }

      // ---- STAGE 5: activate, retaining the outgoing generation ----------------------------------------
      if (stage === 'verified') {
        activatePendingGeneration(resolved.stateDir, root, now);
        writeJournal(resolved, { stage: 'activated', fromGeneration: resolved.fromGeneration, toGeneration, startedAt: now() });
        stage = 'activated';
      }
      verifiedAll = true;
      // The journal has done its job the moment the ring is authoritative.
      rmSync(rotationJournalPath(resolved.stateDir), { force: true });
    } catch (err) {
      // ---- BOTH FACTS, WHERE BOTH ARE TRUE --------------------------------------------------------------
      //
      // The restart below runs first (it is in the `finally`), so by the time this rethrows, `stillStopped`
      // is populated. A primary failure AND an outage is two problems, and the urgent one is the outage — so
      // it is ADDED to the refusal rather than left in a report a thrown failure never returns.
      restartQuiesced();
      restarted = true;
      throw withOutage(err, stillStopped);
    } finally {
      // ALWAYS, on every path out: a refusal, a throw, a success. The same rule as the backup's window, and
      // for the same reason — a command that leaves the stack down has caused the outage it was insurance
      // against. Every service that WAS stopped gets an attempt, in reverse order, INCLUDING when the quiesce
      // itself was what failed.
      restartQuiesced();
    }

    const finalRing = loadKekRing(resolved.stateDir, root);
    notes.push('The OUTGOING generation is still in the ring. Every backup taken before this rotation holds '
      + 'keys under it, and removing it now would make all of them unrestorable. Take a complete backup, '
      + 'verify it, and then retire that generation deliberately.');
    return report({
      ok: stage === 'activated' && stillStopped.length === 0,
      planDigest: resolved.planDigest,
      stage,
      fromGeneration: resolved.fromGeneration,
      toGeneration,
      keys,
      verifiedAll,
      ring: summarizeKekRing(finalRing, root),
      quiesced,
      stillStopped,
      notes,
    });
  } finally {
    lock.release();
  }
}

/**
 * Retire a retained generation, after a post-rotation backup that verifies.
 *
 * SEPARATE, EXPLICIT, AND GATED. This is the irreversible half of a rotation: the moment it runs, every
 * backup taken while that generation was active stops being restorable. It is not something a rotation does
 * on its own, and it is not something a flag on the rotation command does either.
 */
export const RETIREMENT_REPORT = 'phase-283-kek-retirement';

export interface RetirementRequest {
  readonly stateDir: string;
  readonly rootKeyFile: string;
  readonly backupSet: string;
  readonly generation: number;
}

export interface ResolvedRetirement extends RetirementRequest {
  readonly planDigest: string;
  readonly rootKeyId: string;
  readonly activeGeneration: number;
  readonly backupSetDigest: string;
}

/**
 * Resolve a retirement, proving everything, and CHANGE NOTHING.
 *
 * RETIREMENT IS THE IRREVERSIBLE HALF OF A ROTATION. The moment it runs, every backup taken while that
 * generation was active stops being restorable by this installation. It therefore gets the same plan/confirm
 * gate as the rotation itself, and the proof below rather than a timestamp.
 *
 * THE DEFECT THIS CLOSES. The first version wrapped its whole proof in `if (existsSync(staged))` — so a backup
 * set with NO keystore artifact skipped the check entirely and retired the generation on the strength of the
 * set merely verifying. A set without a keystore is precisely the set that cannot restore a custodian, which
 * is the one thing the proof exists to establish.
 */
export function planKekRetirement(request: RetirementRequest): ResolvedRetirement {
  const stateDir = resolveMaintenanceRoot(request.stateDir, 'sidecar state directory');
  const backupSet = resolveMaintenanceRoot(request.backupSet, 'backup set directory');
  const verification = verifyBackupSet(backupSet);
  if (!verification.ok || verification.setDigest === '') {
    throw new MaintenanceRefused(
      'the complete backup you named does not verify, so retiring a generation now would remove the only key '
      + 'that can open the sets you already have. Nothing was changed.');
  }
  const root = readRootWrappingKey(request.rootKeyFile);
  const ring = loadKekRing(stateDir, root);
  if (request.generation === ring.active) throw new KekRingError('the ACTIVE generation cannot be retired');
  if (request.generation === ring.pending) throw new KekRingError('a PENDING generation cannot be retired');
  if (!ring.generations.some((entry) => entry.generation === request.generation)) {
    throw new KekRingError('the KEK ring holds no such generation');
  }

  assertBackupProvesPostRotationState(backupSet, request, ring.active);

  const resolved = {
    ...request,
    stateDir,
    backupSet,
    rootKeyId: rootKeyId(root),
    activeGeneration: ring.active,
    backupSetDigest: verification.setDigest,
  };
  return { ...resolved, planDigest: retirementPlanDigest(resolved) };
}

export function retirementPlanDigest(plan: Omit<ResolvedRetirement, 'planDigest'>): string {
  return createHash('sha256').update(JSON.stringify({
    report: RETIREMENT_REPORT,
    version: KEK_ROTATION_VERSION,
    stateDir: createHash('sha256').update(plan.stateDir, 'utf8').digest('hex'),
    rootKeyId: plan.rootKeyId,
    generation: plan.generation,
    activeGeneration: plan.activeGeneration,
    backupSetDigest: plan.backupSetDigest,
  }), 'utf8').digest('hex');
}

/**
 * Prove the named backup is one taken AFTER the rotation, and is restorable on its own terms.
 *
 * FOUR THINGS, AND NONE OF THEM IS A TIMESTAMP:
 *
 *   1. THE KEYSTORE ARTIFACT MUST BE THERE. Its absence used to skip the whole proof.
 *   2. THE BACKED-UP ROOT SECRET MUST OPEN THE BACKED-UP RING. A set holding a ring and a root that do not
 *      match is a set that restores into an installation which can open nothing.
 *   3. EVERY BACKED-UP LIVE KEY MUST OPEN UNDER THAT RING'S ACTIVE GENERATION.
 *   4. THAT GENERATION MUST BE THE ONE THIS INSTALLATION IS ON. A set from after a DIFFERENT rotation is not
 *      evidence about this one.
 */
function assertBackupProvesPostRotationState(
  backupSet: string,
  request: RetirementRequest,
  activeGeneration: number,
): void {
  const stagedKeystore = join(backupSet, 'keystore-backup');
  if (!existsSync(stagedKeystore)) {
    throw new MaintenanceRefused(
      'the backup you named holds no keystore component, so it cannot show that this installation is past the '
      + 'rotation — and a set without a keystore cannot restore a custodian at all. Retiring a generation on '
      + 'that evidence would remove a key nothing else holds. Take a complete backup now, verify it, and '
      + 'retire against that one.');
  }
  const stagedSecrets = join(backupSet, 'secrets-backup');
  const stagedRootKeyFile = join(stagedSecrets, 'custodian_root_key');
  if (!existsSync(stagedRootKeyFile)) {
    throw new MaintenanceRefused(
      'the backup you named holds no root wrapping key, so its ring could never be opened from it. Nothing was '
      + 'changed.');
  }
  let backedUpRoot: Buffer;
  try {
    backedUpRoot = readKeyFileFromBackup(stagedRootKeyFile);
  } catch {
    throw new MaintenanceRefused('the root wrapping key inside the backup you named could not be read');
  }
  let backedUpRing;
  try {
    backedUpRing = loadKekRing(stagedKeystore, backedUpRoot);
  } catch {
    throw new MaintenanceRefused(
      'the root wrapping key inside the backup you named does not open the ring inside it. That set cannot '
      + 'restore this installation, so it is not evidence that a generation is safe to remove.');
  }
  if (backedUpRing.active !== activeGeneration) {
    throw new MaintenanceRefused(
      'the backup you named was taken while a DIFFERENT generation was active, so it is not evidence about the '
      + 'rotation you have just performed. Take a complete backup now, verify it, and retire against that one.');
  }
  if (backedUpRing.generations.some((entry) => entry.generation === request.generation)
    && backedUpRing.active === request.generation) {
    throw new MaintenanceRefused('the backup you named is still on the generation you are trying to retire');
  }
  const backedUpActive = activeKek(backedUpRing);
  let allOpen = false;
  try {
    const plan = FileCustodian.planRewrapKeystore(stagedKeystore, { fromKek: backedUpActive, toKek: backedUpActive });
    allOpen = plan.total > 0 && plan.alreadyCurrent === plan.total;
  } catch {
    allOpen = false;
  }
  if (!allOpen) {
    throw new MaintenanceRefused(
      'not every wrapped key inside the backup you named opens under that backup\'s own active generation, so '
      + 'it is not a set this installation could restore from. Nothing was changed.');
  }
}

/** A 32-byte key read out of a backup set. No ownership rule: a copied secret file is not the live one. */
function readKeyFileFromBackup(path: string): Buffer {
  const bytes = readFileSync(path, 'utf8').trim();
  const decoded = decodeKey(bytes);
  if (decoded === null) throw new KekRingError('the key file in the backup does not hold 32 bytes');
  return decoded;
}

export interface RetirementReport {
  readonly report: typeof RETIREMENT_REPORT;
  readonly ok: boolean;
  readonly planDigest: string;
  readonly retired: number;
  readonly ring: KekRingSummary;
  readonly notes: readonly string[];
}

/** Retire, under the lock, having re-resolved and re-proved everything the plan claimed. */
export function retireKekGeneration(
  request: RetirementRequest & { readonly confirmDigest: string | null },
): RetirementReport {
  const first = planKekRetirement(request);
  if (request.confirmDigest !== first.planDigest) {
    throw new MaintenanceRefused(
      'the digest you confirmed is not the digest of the retirement this command just computed. Nothing was '
      + 'changed. Retirement removes a key permanently: run with --plan, read it, and copy that digest.');
  }
  const lock = acquireLockDirectory(join(first.stateDir, ROTATION_LOCK_DIRNAME),
    'another key operation is already running against this sidecar state, or one was interrupted and left its '
    + 'lock behind.');
  try {
    const resolved = planKekRetirement(request);
    if (resolved.planDigest !== first.planDigest) {
      throw new MaintenanceRefused(
        'the ring or the backup changed between reading this plan and running it. Nothing was changed.');
    }
    const root = readRootWrappingKey(request.rootKeyFile);
    const after = retireGeneration(resolved.stateDir, root, request.generation);
    return {
      report: RETIREMENT_REPORT,
      ok: true,
      planDigest: resolved.planDigest,
      retired: request.generation,
      ring: summarizeKekRing(after, root),
      notes: [
        'That generation is gone from the ring. Any backup taken while it was active can no longer be restored '
        + 'by this installation, which is what retirement means and is why it is a separate, confirmed command.',
      ],
    };
  } finally {
    lock.release();
  }
}

// -----------------------------------------------------------------------------------------------------------
// Rotating the ROOT wrapping key, as a plan and a confirmation
// -----------------------------------------------------------------------------------------------------------

export const ROOT_ROTATION_REPORT = 'phase-283-root-key-rotation';

export interface RootRotationRequest {
  readonly stateDir: string;
  readonly rootKeyFile: string;
  readonly newRootKeyFile: string;
  readonly backupSet: string;
}

export interface ResolvedRootRotation extends RootRotationRequest {
  readonly planDigest: string;
  readonly fromRootKeyId: string;
  readonly toRootKeyId: string;
  /** The generation the ring is on right now. A plan read against one ring cannot be spent on another. */
  readonly activeGeneration: number;
  /** The verified set's own digest. Binds the plan to the BYTES of the backup, not to a path. */
  readonly backupSetDigest: string;
}

/**
 * Resolve a root-key rotation, and CHANGE NOTHING.
 *
 * THE DEFECT THIS CLOSES. `--root-rotate --plan` called `rotateRootWrappingKey` directly: the flag whose whole
 * purpose is "tell me what would happen" re-sealed the ring under a new root and left the previous root unable
 * to open it. An operator rehearsing a change had already made it, and the only warning was that the output
 * described it in the past tense.
 *
 * So planning is a pure function of what is on disk. It reads the ring to learn which generation and which
 * root it is bound to, verifies the backup, and returns a digest. Nothing is written.
 */
export function planRootKeyRotation(request: RootRotationRequest): ResolvedRootRotation {
  const stateDir = resolveMaintenanceRoot(request.stateDir, 'sidecar state directory');
  const backupSet = resolveMaintenanceRoot(request.backupSet, 'backup set directory');
  const fromRoot = readRootWrappingKey(request.rootKeyFile);
  const toRoot = readRootWrappingKey(request.newRootKeyFile);
  if (fromRoot.length === toRoot.length && timingSafeEqual(fromRoot, toRoot)) {
    throw new KekRingError('the new root wrapping key is the current one, so there is nothing to re-seal');
  }
  // THE RING MUST OPEN UNDER THE ROOT WE ARE MOVING AWAY FROM, established here rather than at the write.
  const ring = loadKekRing(stateDir, fromRoot);
  const verification = verifyBackupSet(backupSet);
  if (!verification.ok || verification.setDigest === '') {
    throw new MaintenanceRefused(
      're-sealing the ring under a new root wrapping key is the one operation after which the OLD root opens '
      + 'nothing. Without a complete backup that verifies NOW there is nothing to go back to. Nothing was '
      + 'changed.');
  }
  const resolved = {
    ...request,
    stateDir,
    backupSet,
    fromRootKeyId: rootKeyId(fromRoot),
    toRootKeyId: rootKeyId(toRoot),
    activeGeneration: ring.active,
    backupSetDigest: verification.setDigest,
  };
  return { ...resolved, planDigest: rootRotationPlanDigest(resolved) };
}

/** Over which state, which root now, which root next, which generation, and which exact backup. */
export function rootRotationPlanDigest(plan: Omit<ResolvedRootRotation, 'planDigest'>): string {
  return createHash('sha256').update(JSON.stringify({
    report: ROOT_ROTATION_REPORT,
    version: KEK_ROTATION_VERSION,
    stateDir: createHash('sha256').update(plan.stateDir, 'utf8').digest('hex'),
    fromRootKeyId: plan.fromRootKeyId,
    toRootKeyId: plan.toRootKeyId,
    activeGeneration: plan.activeGeneration,
    backupSetDigest: plan.backupSetDigest,
  }), 'utf8').digest('hex');
}

export interface RootRotationReport {
  readonly report: typeof ROOT_ROTATION_REPORT;
  readonly ok: boolean;
  readonly planDigest: string;
  readonly fromRootKeyId: string;
  readonly toRootKeyId: string;
  readonly activeGeneration: number;
  /** The new root was proved to open the SAME ring, not merely some ring. */
  readonly ringUnchanged: boolean;
  readonly network: 'none';
  readonly notes: readonly string[];
}

/**
 * Re-seal the ring under a new root wrapping key, under the lock, having re-resolved everything.
 *
 * WHY IT RE-RESOLVES. Between the plan an operator read and the command they ran, the ring can have been
 * rotated, the backup replaced, or the root files swapped. The digest catches all of that only if it is
 * recomputed from what is on disk NOW — which is what `planRootKeyRotation` does again here, inside the lock.
 */
export function runRootKeyRotation(
  request: RootRotationRequest & { readonly confirmDigest: string | null },
): RootRotationReport {
  const first = planRootKeyRotation(request);
  if (request.confirmDigest !== first.planDigest) {
    throw new MaintenanceRefused(
      'the digest you confirmed is not the digest of the root-key rotation this command just computed. Nothing '
      + 'was changed. Run with --plan, read it, and copy the digest from the plan you actually read.');
  }
  const lock = acquireLockDirectory(join(first.stateDir, ROTATION_LOCK_DIRNAME),
    'another key operation is already running against this sidecar state, or one was interrupted and left its '
    + 'lock behind.');
  try {
    // RE-RESOLVED UNDER THE LOCK. Anything that moved between the first resolution and this one changes the
    // digest, and a changed digest is a refusal rather than a re-plan.
    const resolved = planRootKeyRotation(request);
    if (resolved.planDigest !== first.planDigest) {
      throw new MaintenanceRefused(
        'the ring, the root keys or the backup changed between reading this plan and running it. Nothing was '
        + 'changed. Re-run with --plan against what is actually there.');
    }
    const fromRoot = readRootWrappingKey(request.rootKeyFile);
    const toRoot = readRootWrappingKey(request.newRootKeyFile);
    const before = ringContentsDigest(loadKekRing(resolved.stateDir, fromRoot));

    rotateRootWrappingKey(resolved.stateDir, fromRoot, toRoot);

    // THE NEW ROOT MUST OPEN THE EXACT RING, not merely a ring. A re-seal that produced a well-formed ring
    // with different contents would be a silent loss of every generation it dropped.
    const after = ringContentsDigest(loadKekRing(resolved.stateDir, toRoot));
    const ringUnchanged = after === before;
    if (!ringUnchanged) {
      throw new MaintenanceRefused(
        'the ring that came back under the new root wrapping key is not the ring that went in. Do not remove '
        + 'the previous root key file: restore the sidecar state from the verified backup this rotation was '
        + 'gated on.');
    }
    return {
      report: ROOT_ROTATION_REPORT,
      ok: true,
      planDigest: resolved.planDigest,
      fromRootKeyId: resolved.fromRootKeyId,
      toRootKeyId: resolved.toRootKeyId,
      activeGeneration: resolved.activeGeneration,
      ringUnchanged,
      network: 'none',
      notes: [
        'No key file was touched and nothing was re-wrapped: what changed is which 32 bytes open the ring. '
        + 'Every wrapped key is under exactly the generation it was under before.',
        'Keep the previous root key file until you have taken a complete backup under the new one and verified '
        + 'it. Until then it is what opens every backup you already have.',
      ],
    };
  } finally {
    lock.release();
  }
}

/**
 * A digest over what a ring CONTAINS, independent of which root sealed it.
 *
 * Used to prove a re-seal preserved the ring exactly. It is computed inside this process from an already
 * decrypted ring and never leaves it — the report carries the verdict, not this value.
 */
function ringContentsDigest(ring: { readonly generations: readonly { readonly generation: number; readonly state: string; readonly keyHex: string; readonly createdAt: number; readonly origin: string }[]; readonly active: number; readonly pending: number | null }): string {
  return createHash('sha256').update(JSON.stringify([
    ring.active,
    ring.pending,
    [...ring.generations]
      .slice()
      .sort((a, b) => a.generation - b.generation)
      .map((entry) => [entry.generation, entry.state, entry.keyHex, entry.createdAt, entry.origin]),
  ]), 'utf8').digest('hex');
}

/** How old an active generation may be before the doctor says so. A policy, stated once. */
export const KEK_ROTATION_DUE_DAYS = 180;
export const KEK_ROTATION_OVERDUE_DAYS = 365;

export type KekRotationAge = 'current' | 'due' | 'overdue' | 'unknown';

/**
 * How overdue a rotation is, as a closed word.
 *
 * A DATE IS NOT A VERDICT AND A VERDICT IS NOT A DATE. The doctor carries the word; the age in days is a
 * number an operator can act on. Neither carries a key, a path or a generation's contents.
 */
export function classifyKekRotationAge(activeCreatedAt: number, now: number): KekRotationAge {
  if (!Number.isInteger(activeCreatedAt) || activeCreatedAt <= 0) return 'unknown';
  const days = (now - activeCreatedAt) / (24 * 60 * 60 * 1000);
  if (days >= KEK_ROTATION_OVERDUE_DAYS) return 'overdue';
  if (days >= KEK_ROTATION_DUE_DAYS) return 'due';
  return 'current';
}

function composeCommand(resolved: ResolvedKekRotation, args: readonly string[], purpose: string): MaintenanceCommand {
  return {
    program: 'docker',
    args: ['compose', '-p', resolved.projectName, ...args],
    cwd: resolved.projectRoot,
    purpose,
  };
}

function writeJournal(
  resolved: ResolvedKekRotation,
  fields: { stage: RotationStage; fromGeneration: number; toGeneration: number | null; startedAt: number },
): void {
  writeStateDocument(rotationJournalPath(resolved.stateDir), {
    rotation: KEK_ROTATION_REPORT,
    version: KEK_ROTATION_VERSION,
    planDigest: resolved.planDigest,
    ...fields,
  } satisfies RotationJournal);
}

function report(fields: Omit<KekRotationReport, 'report' | 'version' | 'backupVerified' | 'network' | 'restarted'>): KekRotationReport {
  return {
    report: KEK_ROTATION_REPORT,
    version: KEK_ROTATION_VERSION,
    backupVerified: true,
    restarted: fields.stillStopped.length === 0,
    network: 'none',
    ...fields,
  };
}

/** How many wrapped keys a keystore holds. A count for a report; it opens nothing. */
export function countKeystoreEntries(stateDir: string): number {
  const keysDir = join(stateDir, 'keys');
  if (!existsSync(keysDir)) return 0;
  return readdirSync(keysDir).filter((entry) => entry.endsWith('.json')).length;
}
