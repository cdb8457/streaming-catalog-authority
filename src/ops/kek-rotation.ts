import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FileCustodian } from '../core/crypto/file-custodian.js';
import {
  KEK_RING_DIRNAME,
  KekRingError,
  activatePendingGeneration,
  activeKek,
  adoptStaticKekAsRing,
  beginPendingGeneration,
  decodeKey,
  kekForGeneration,
  kekRingExists,
  kekRingPath,
  loadKekRing,
  readRootWrappingKey,
  retireGeneration,
  rootKeyId,
  rotateRootWrappingKey,
  summarizeKekRing,
  wholeRingDigest,
  type KekRing,
  type KekRingSummary,
  type RootReSealFaults,
} from '../core/crypto/kek-ring.js';
import {
  CUSTODIAN_WRITER_LOCK,
  CustodianStateError,
  acquireStateLock,
  readStateDocument,
  readStateFileBytes,
  stateDirectoryIdentity,
  writeStateDocument,
  type StateDirectoryIdentity,
  type StateLock,
} from '../core/crypto/custodian-state-io.js';
import { readKeyFileNoFollow } from './kek-ring-secret-io.js';
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
  // A JOURNAL IS READ BEFORE IT IS BELIEVED, AND THE PLAN IS WHERE IT IS FIRST BELIEVED — `fromGeneration`
  // below is taken from it. A journal that does not describe a rotation this ring could be in the middle of
  // is refused here, so no digest is ever printed for one.
  if (journal !== null) assertRotationJournalAgreesWithRing(journal, ring);
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
    // AN EMPTY KEYSTORE IS A COMPLETE PROOF, NOT A FAILED ONE. "Every key opens" over nothing is vacuously
    // true, and that is the correct answer: an installation that has stored no item yet is a legitimate
    // state, and `total > 0` turned it into a permanent refusal — a rotation that could never resume and a
    // retirement that could never proceed, on exactly the installation with the least to lose. Every other
    // suite here drives a populated keystore, so the proof is not vacuous in practice.
    return plan.alreadyCurrent === plan.total;
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
 * A journal must describe a rotation THIS RING COULD BE IN THE MIDDLE OF.
 *
 * -----------------------------------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES, AND IT REPORTED SUCCESS.
 * -----------------------------------------------------------------------------------------------------
 *
 * `readRotationJournal` checked the journal's SHAPE: closed field set, a digest that looks like a digest,
 * generations that are positive integers, a stage from the closed list. Every one of those passed for this
 * file:
 *
 *     { fromGeneration: 1, toGeneration: 1, stage: 'verified', ... }
 *
 * Dropped into the state directory of an installation on generation 1, it made `planKekRotation` take
 * `fromGeneration` from the journal (1, the same as the ring's), so the plan digest matched. The stage
 * reconciliation then found generation 1 in the ring, found `ring.active === 1`, found every key already
 * opening under it, and concluded `activated`. Every stage was skipped, the ring never moved, no key was
 * rewrapped — and the command printed `KEK rotation — COMPLETE`, `reached stage activated`, `every key
 * verified true`. An operator rotating in response to a suspected key disclosure was told the rotation had
 * happened. The one check that would have caught it is that a rotation FROM a generation TO the same
 * generation is not a rotation.
 *
 * So the journal's three claims are checked against the ring RELATIONALLY, not merely for well-formedness:
 *
 *   * `from` is a generation this ring actually holds;
 *   * `from` and `to` are different — no rotation moves a generation onto itself;
 *   * where the ring has a PENDING generation, `to` is that generation and `from` is the ring's active one:
 *     a journal naming some other successor describes a different rotation from the one in progress;
 *   * where the ring has no pending generation and DOES hold `to`, the activation has happened — so `to` is
 *     the active generation and `from` is retained beside it;
 *   * otherwise nothing was created yet, so the ring must still be active on `from`.
 *
 * This is not a stage check. A journal may UNDERSTATE where the rotation got to (every step is idempotent, so
 * a resume repeats work harmlessly) and it may OVERSTATE it (the reconciliation demotes it against the ring
 * and the keystore). What it may not do is describe a rotation between generations this ring is not between.
 */
export function assertRotationJournalAgreesWithRing(journal: RotationJournal, ring: KekRing): void {
  const holds = (generation: number): boolean => ring.generations.some((entry) => entry.generation === generation);
  const refuse = (why: string): never => {
    throw new KekRingError(
      `${why} Refused: this build will not resume a rotation whose journal does not describe the ring it is `
      + 'beside. Nothing was changed.');
  };
  if (!holds(journal.fromGeneration)) {
    refuse('the rotation journal names a generation to rotate away from that is not in this ring.');
  }
  if (journal.toGeneration !== null && journal.toGeneration === journal.fromGeneration) {
    refuse('the rotation journal names the SAME generation as both the one being rotated away from and the '
      + 'one being rotated onto. That is not a rotation, and a run resuming it would report a completed '
      + 'rotation having moved nothing.');
  }
  if (ring.pending !== null) {
    if (journal.toGeneration !== ring.pending) {
      refuse('this ring has a pending generation and the rotation journal names a different one.');
    }
    if (ring.active !== journal.fromGeneration) {
      refuse('the rotation journal names a generation to rotate away from that is not the one this ring is '
        + 'active on.');
    }
    return;
  }
  if (journal.toGeneration !== null && holds(journal.toGeneration)) {
    // No pending pointer and the successor is in the ring: the activation already happened, or this journal
    // is about some other pair of generations entirely.
    if (ring.active !== journal.toGeneration) {
      refuse('the rotation journal names a generation to rotate onto that this ring holds but is not active '
        + 'on, and no rotation is pending.');
    }
    const outgoing = ring.generations.find((entry) => entry.generation === journal.fromGeneration)!;
    if (outgoing.state !== 'retired') {
      refuse('the rotation journal describes a completed activation, but the generation it names as outgoing '
        + 'is not retained beside the active one.');
    }
    return;
  }
  // Nothing was created, so nothing can have moved.
  if (ring.active !== journal.fromGeneration) {
    refuse('the rotation journal describes a rotation from a generation this ring is not active on, and the '
      + 'generation it names as the successor was never created.');
  }
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
      // RE-CHECKED AGAINST THE RING UNDER THE LOCK, and against the plan this run is executing. A journal
      // swapped between the plan and the lock would otherwise decide `fromGeneration` for a rotation whose
      // digest was computed from a different one.
      assertRotationJournalAgreesWithRing(journal, loadKekRing(resolved.stateDir, root));
      if (journal.fromGeneration !== resolved.fromGeneration) {
        throw new MaintenanceRefused(
          'the rotation journal in this state directory names a different generation to rotate away from than '
          + 'the plan this run is executing. Nothing was changed and nothing was stopped.');
      }
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
export function planKekRetirement(
  request: RetirementRequest,
  seams: ProofBindingSeams = {},
): ResolvedRetirement {
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

  // THE PROOF IS BOUND TO THE SET THAT VERIFIED. Same rule as the root rotation's: the digest this plan
  // carries and the custody proof it rests on have to be about the same bytes, or the plan is two claims
  // about two sets presented as one.
  assertBackupProvesPostRotationState(backupSet, verification.setDigest, request, ring.active, seams);

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
  setDigest: string,
  request: RetirementRequest,
  activeGeneration: number,
  seams: ProofBindingSeams,
): void {
  const proof = proveBackupCustodyBoundToSet(backupSet, setDigest,
    'Retiring a generation on that evidence would remove a key nothing else holds. Take a complete backup '
    + 'now, verify it, and retire against that one.', seams);
  if (proof.activeGeneration !== activeGeneration) {
    throw new MaintenanceRefused(
      'the backup you named was taken while a DIFFERENT generation was active, so it is not evidence about the '
      + 'rotation you have just performed. Take a complete backup now, verify it, and retire against that one.');
  }
  if (proof.activeGeneration === request.generation) {
    throw new MaintenanceRefused('the backup you named is still on the generation you are trying to retire');
  }
}

/**
 * What a backup set must independently prove before it counts as somewhere to go back to.
 *
 * A VERIFICATION IS NOT A RESTORABILITY PROOF. `verifyBackupSet` establishes that a set is internally
 * consistent — every artifact present, every digest matching its manifest. A set can pass all of that and
 * still be unable to restore this installation: it can hold no keystore at all, hold a keystore with no ring,
 * or hold a root wrapping key that is not the one its own ring is sealed under (which is what a set taken
 * from a project whose secrets copy drifted looks like — it verifies perfectly and opens nothing).
 *
 * So the set is opened on its own terms, using only what is inside it:
 *
 *   1. THE KEYSTORE COMPONENT IS THERE. A set without one cannot restore a custodian at all.
 *   2. THE ROOT WRAPPING KEY IS THERE AND IS 32 BYTES.
 *   3. THAT ROOT OPENS THE RING BESIDE IT, and the ring passes every structural rule this build enforces.
 *   4. EVERY WRAPPED KEY IN THE SET OPENS UNDER THAT RING'S OWN ACTIVE GENERATION. An empty keystore is a
 *      complete proof over zero keys, for the same reason it is everywhere else in this file.
 *
 * The digests it returns bind a plan to THIS set's custody state, so a set replaced at the same path between
 * a plan and its confirmation changes the digest rather than passing the same checks as a different set.
 */
export interface BackupCustodyProof {
  /** A non-reversible label for the root wrapping key inside the set. Never the key. */
  readonly rootKeyId: string;
  /** A digest over the whole ring inside the set. Never any part of it. */
  readonly ringDigest: string;
  readonly activeGeneration: number;
  readonly generations: readonly number[];
}

export function proveBackupRestoresCustody(backupSet: string, consequence: string): BackupCustodyProof {
  const stagedKeystore = join(backupSet, 'keystore-backup');
  if (!existsSync(stagedKeystore)) {
    throw new MaintenanceRefused(
      `the backup you named holds no keystore component, so it cannot restore a custodian at all. ${consequence}`);
  }
  const stagedRootKeyFile = join(backupSet, 'secrets-backup', 'custodian_root_key');
  if (!existsSync(stagedRootKeyFile)) {
    throw new MaintenanceRefused(
      `the backup you named holds no root wrapping key, so its ring could never be opened from it. ${consequence}`);
  }
  let backedUpRoot: Buffer;
  try {
    backedUpRoot = readKeyFileFromBackup(stagedRootKeyFile);
  } catch {
    throw new MaintenanceRefused(
      `the root wrapping key inside the backup you named could not be read. ${consequence}`);
  }
  let backedUpRing: KekRing;
  try {
    backedUpRing = loadKekRing(stagedKeystore, backedUpRoot);
  } catch {
    throw new MaintenanceRefused(
      'the root wrapping key inside the backup you named does not open the ring inside it. That set cannot '
      + `restore this installation. ${consequence}`);
  }
  const backedUpActive = activeKek(backedUpRing);
  let allOpen = false;
  try {
    const plan = FileCustodian.planRewrapKeystore(stagedKeystore, { fromKek: backedUpActive, toKek: backedUpActive });
    // Empty is complete, for the same reason as `everyKeyOpensUnder`: a backup of an installation that has
    // stored nothing yet is a set every one of whose (zero) keys opens.
    allOpen = plan.alreadyCurrent === plan.total;
  } catch {
    allOpen = false;
  }
  if (!allOpen) {
    throw new MaintenanceRefused(
      'not every wrapped key inside the backup you named opens under that backup\'s own active generation, so '
      + `it is not a set this installation could restore from. ${consequence}`);
  }
  return {
    rootKeyId: rootKeyId(backedUpRoot),
    ringDigest: wholeRingDigest(backedUpRing),
    activeGeneration: backedUpRing.active,
    generations: backedUpRing.generations.map((entry) => entry.generation).sort((a, b) => a - b),
  };
}

/**
 * The one seam that makes every proof-to-digest binding in this file testable rather than merely written down.
 *
 * NOT PASSED ANYWHERE IN PRODUCTION. It stands for a retention schedule, a sync job, a restore or an operator
 * changing what a plan is reading while the plan is being computed — which is a thing that happens on a NAS,
 * on a schedule, with nothing coordinating with this command.
 */
export interface ProofBindingSeams {
  /** Runs after a proof and before the re-read that binds it to the digest a plan will carry. */
  readonly betweenProofAndRebind?: () => void;
}

/**
 * Prove a set restores custody, and BIND that proof to the set digest a plan is about to carry.
 *
 * -----------------------------------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES: TWO READS, ONE CLAIM.
 * -----------------------------------------------------------------------------------------------------
 *
 * A plan used to call `verifyBackupSet` once and `proveBackupRestoresCustody` separately, then record
 * `backupSetDigest` from the first and `backupRootKeyId` / `backupRingDigest` / `backupActiveGeneration`
 * from the second. Those are two reads of a directory nothing holds still. A set replaced at the same path
 * between them — a retention schedule rolling a nightly, a sync finishing, an operator restoring — produced
 * a plan whose digest bound SET A while its custody proof described SET B. Both halves were true of
 * something; neither was true of the same set, and the digest an operator confirmed said they were.
 *
 * So the set is verified AGAIN after the proof and must be the same set. What that establishes, precisely:
 * the manifest and every component digest that made the set verify are unchanged across the whole of the
 * proof, so the ring, the root key and the wrapped keys the proof opened are the bytes the digest names. A
 * set that moved is a refusal — this reads a directory it does not own and cannot lock, and the honest
 * response to "it changed while I was looking" is to say so rather than to publish half a claim.
 */
export function proveBackupCustodyBoundToSet(
  backupSet: string,
  setDigest: string,
  consequence: string,
  seams: ProofBindingSeams = {},
): BackupCustodyProof {
  const proof = proveBackupRestoresCustody(backupSet, consequence);
  seams.betweenProofAndRebind?.();
  const rebound = verifyBackupSet(backupSet);
  if (!rebound.ok || rebound.setDigest !== setDigest) {
    throw new MaintenanceRefused(
      'the backup set changed while this command was proving it: the set that verified and the set whose '
      + 'custody proof this plan would carry are not the same bytes. A plan that recorded both would be '
      + 'binding a digest to a proof about a set that is no longer there. Nothing was changed. Stop whatever '
      + `is writing that path — a retention schedule, a sync, a restore — and plan again. ${consequence}`);
  }
  return proof;
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
  /**
   * A digest over the WHOLE ring as it is before this runs — the state the rollback would put back.
   *
   * It is what makes "the ring came back unchanged" checkable against something decided BEFORE the write
   * rather than against a value read after it.
   */
  readonly preStateDigest: string;
  /** The custody state the named backup independently proves it can restore. Labels and digests only. */
  readonly backupRootKeyId: string;
  readonly backupRingDigest: string;
  readonly backupActiveGeneration: number;
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
export function planRootKeyRotation(
  request: RootRotationRequest,
  seams: ProofBindingSeams = {},
): ResolvedRootRotation {
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
  // ---- AND THE SET MUST BE ABLE TO RESTORE CUSTODY, NOT MERELY VERIFY ------------------------------------
  //
  // THE HOLE THIS CLOSES. The gate was `verifyBackupSet(...).ok` and nothing else — a set that is internally
  // consistent. A set can be perfectly consistent and hold no keystore, or a keystore with no ring, or a root
  // wrapping key that does not open its own ring. Every one of those passed, and this is the ONE operation
  // after which the previous root key opens nothing: the fallback the whole gate exists to guarantee was
  // never checked for being a fallback. So the set is opened on its own terms and proved to hold a usable
  // root key, a complete ring, and a keystore every wrapped key of which reads under that ring.
  //
  // AND THE PROOF AND THE DIGEST ARE ABOUT THE SAME BYTES. The verification above and the proof below are two
  // reads of a directory nothing holds still; `proveBackupCustodyBoundToSet` re-verifies afterwards and
  // refuses a set that moved, so this plan cannot bind one set's digest to another set's custody proof.
  const backup = proveBackupCustodyBoundToSet(backupSet, verification.setDigest,
    'After a re-seal the PREVIOUS root wrapping key opens nothing, so a set that cannot restore this '
    + 'installation is not somewhere to go back to. Nothing was changed.', seams);
  const resolved = {
    ...request,
    stateDir,
    backupSet,
    fromRootKeyId: rootKeyId(fromRoot),
    toRootKeyId: rootKeyId(toRoot),
    activeGeneration: ring.active,
    backupSetDigest: verification.setDigest,
    preStateDigest: wholeRingDigest(ring),
    backupRootKeyId: backup.rootKeyId,
    backupRingDigest: backup.ringDigest,
    backupActiveGeneration: backup.activeGeneration,
  };
  // FROZEN. A plan is a decision an operator confirmed; a caller that could edit one between the print and
  // the run would be editing the thing the digest is supposed to bind.
  return Object.freeze({ ...resolved, planDigest: rootRotationPlanDigest(resolved) });
}

/** Over which state, which root now, which root next, which ring exactly, and which exact backup. */
export function rootRotationPlanDigest(plan: Omit<ResolvedRootRotation, 'planDigest'>): string {
  return createHash('sha256').update(JSON.stringify({
    report: ROOT_ROTATION_REPORT,
    version: KEK_ROTATION_VERSION,
    stateDir: createHash('sha256').update(plan.stateDir, 'utf8').digest('hex'),
    fromRootKeyId: plan.fromRootKeyId,
    toRootKeyId: plan.toRootKeyId,
    activeGeneration: plan.activeGeneration,
    // THE WHOLE RING, NOT JUST WHICH GENERATION IS ACTIVE. A retirement or a begun rotation between the plan
    // and the run leaves `active` unchanged while changing what a rollback would have to put back.
    preStateDigest: plan.preStateDigest,
    backupSetDigest: plan.backupSetDigest,
    backupRootKeyId: plan.backupRootKeyId,
    backupRingDigest: plan.backupRingDigest,
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
  faults: RootReSealFaults = {},
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

    // THE WRITE, THE PROOF AND THE ROLLBACK ARE ONE OPERATION, UNDER ONE LOCK.
    //
    // They used to be three statements here: re-seal, then re-read under the new root, then refuse if the
    // contents differed. Two things were wrong with that. The refusal LEFT THE NEW FILE IN PLACE — an
    // installation whose ring the old root no longer opens and the new one has just been shown not to open
    // either, reported as a refusal about a check. And the ring's writer lock was released between the write
    // and the proof, so the thing being proved was not necessarily the thing that had been written.
    //
    // `rotateRootWrappingKey` now captures the exact previous bytes, writes, proves, and on failure restores
    // those bytes and verifies the restore — all inside the lock — and throws one error carrying the primary
    // failure and the state the installation was left in.
    //
    // ---- AND THE RING IT WRITES IS THE ONE THIS PLAN WAS COMPUTED OVER, CHECKED BEFORE THE WRITE -----------
    //
    // THE SECOND DEFECT THIS CLOSES, WHICH IS ABOUT WHICH LOCK. This function holds the ROTATION lock. Every
    // other ring mutator holds the RING WRITER lock, and those two exclude nothing of each other's: between
    // the re-plan above and the write below, a begun rotation, an activation, a retirement or an adoption
    // could land. The re-seal would then take a ring nobody confirmed under the new root, prove it, and hand
    // back its digest — and the comparison that used to live HERE, after the call, would refuse an operation
    // that had already completed. "Nothing was changed" over an installation whose ring only the NEW root
    // opens is the one outcome worse than either honest one.
    //
    // So `preStateDigest` goes IN. It is compared inside the ring writer lock, before the capture is written
    // over, and a ring that moved is refused with nothing written. No lock is nested to do it.
    const reseal = rotateRootWrappingKey(resolved.stateDir, fromRoot, toRoot, resolved.preStateDigest, faults);

    // UNREACHABLE BY CONSTRUCTION, AND KEPT. The precondition above makes `ringDigest` the digest that was
    // passed in, so this cannot differ. It stays because the cost is one comparison and the alternative is a
    // silent success if that ever stops being true — and if it did fire, the state it describes is the one an
    // operator has to be told about precisely, so the message describes THAT state rather than a refusal.
    if (reseal.ringDigest !== resolved.preStateDigest) {
      throw new MaintenanceRefused(
        'the ring that was re-sealed is not the ring this plan was computed against, AND THE RE-SEAL HAS '
        + 'ALREADY COMPLETED: the NEW root wrapping key now opens the ring in this state directory and the '
        + 'previous one does not. Do not remove either root key file. Check the ring with `status` under the '
        + 'new root, and if it is not the ring you meant to keep, restore the sidecar state from the verified '
        + 'backup this rotation was gated on.');
    }
    return {
      report: ROOT_ROTATION_REPORT,
      ok: true,
      planDigest: resolved.planDigest,
      fromRootKeyId: resolved.fromRootKeyId,
      toRootKeyId: resolved.toRootKeyId,
      activeGeneration: resolved.activeGeneration,
      ringUnchanged: true,
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

// -----------------------------------------------------------------------------------------------------------
// Adopting the static KEK as a ring, as a plan and a confirmation
// -----------------------------------------------------------------------------------------------------------

export const KEK_MIGRATION_REPORT = 'phase-282-kek-ring-migration';

export interface KekMigrationRequest {
  readonly stateDir: string;
  readonly rootKeyFile: string;
  /** The existing STATIC KEK file. A path, never a value — the same rule as every other key input here. */
  readonly staticKeyFile: string;
  readonly backupSet: string;
}

export interface ResolvedKekMigration extends KekMigrationRequest {
  readonly planDigest: string;
  readonly rootKeyId: string;
  /** A non-reversible label for the static KEK being adopted. Binds the plan to WHICH key, never to the key. */
  readonly staticKeyId: string;
  readonly backupSetDigest: string;
  /** A digest over the exact set of wrapped key files the static KEK was proved against. */
  readonly keystoreSetDigest: string;
  readonly keysProved: number;
}

/**
 * Resolve a static-KEK migration, prove everything it rests on, and CHANGE NOTHING.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHAT THE PLAN HAD TO START CARRYING, AND WHY.
 * -----------------------------------------------------------------------------------------------------
 *
 * The migration's digest used to cover three things: the state directory, the root key's label and the static
 * key's label. Everything else it depended on was checked at some point and never bound — so the digest an
 * operator confirmed was compatible with a state directory whose keystore had changed since they read it, and
 * with a backup set that had been replaced at the same path by a retention schedule. Both matter here:
 *
 *   * THE KEYSTORE IS WHAT THE STATIC KEY IS PROVED AGAINST. "Every wrapped key opens under this key" is a
 *     statement about a SET of files. A key file added between the proof and the adoption was never covered
 *     by it, and a ring adopted on that evidence is a ring that opens all but one item — which reads as one
 *     correctly erased item, so nothing reports it.
 *   * THE BACKUP IS THE ONLY WAY BACK. A migration writes a ring beside a keystore nothing can regenerate.
 *
 * So both are digested INTO the plan, the plan is frozen, and the confirmed run recomputes the whole thing
 * under the lock and refuses on any difference.
 *
 * AN EMPTY KEYSTORE IS A VALID MIGRATION. An installation that has stored no item yet has nothing for the
 * static key to be proved against, and "every key opens" over zero keys is true. The plan records how many
 * keys the proof actually covered, so a report cannot present a vacuous proof as an exhaustive one.
 */
export function planKekMigration(
  request: KekMigrationRequest,
  seams: ProofBindingSeams = {},
): ResolvedKekMigration {
  const stateDir = resolveMaintenanceRoot(request.stateDir, 'sidecar state directory');
  const backupSet = resolveMaintenanceRoot(request.backupSet, 'backup set directory');
  if (kekRingExists(stateDir)) {
    throw new MaintenanceRefused(
      'a KEK ring is already in this sidecar state directory, so this installation has already migrated. This '
      + 'command creates a ring and never replaces one.');
  }
  const root = readRootWrappingKey(request.rootKeyFile);
  const staticKek = readKeyFileNoFollow(request.staticKeyFile, 'static KEK');
  const verification = verifyBackupSet(backupSet);
  if (!verification.ok || verification.setDigest === '') {
    throw new MaintenanceRefused(
      'the complete backup you named does not verify. A migration writes a new ring beside a keystore that '
      + 'cannot be regenerated; without a set that verifies NOW there is nothing to go back to. Nothing was '
      + 'changed.');
  }
  // THE SET IS ESTABLISHED BEFORE ANY KEY FILE IS OPENED BY NAME. `keystoreSetDigest` refuses an entry that
  // is not a wrapped key file this custodian wrote, is not a regular file, or will not read through the
  // bounded no-follow reader — so the unwrap proof below runs over a set that has already been stated.
  const setDigest = keystoreSetDigest(stateDir);
  const keys = assertStaticKekOpensKeystore(stateDir, staticKek);
  // ---- AND THE SET THE PROOF COVERED IS THE SET THE DIGEST NAMES ------------------------------------------
  //
  // THE SAME RULE AS THE BACKUP'S, ONE DIRECTORY OVER. The digest and the unwrap proof are two walks of the
  // keystore. A key file added, removed or rewritten between them gives a plan that says "all N of these keys
  // open under this key" about a set the digest does not describe — and a plan is the thing an operator
  // confirms. The confirmed run additionally holds the custodian writer lock across its own re-plan and
  // re-checks after the adoption; this makes the PLAN itself honest, which is the half an operator reads.
  seams.betweenProofAndRebind?.();
  if (keystoreSetDigest(stateDir) !== setDigest) {
    throw new MaintenanceRefused(
      'a wrapped key in this keystore changed while this plan was being computed, so the set every key was '
      + 'proved to open in is not the set this plan would name. Nothing was changed. Quiesce the app and the '
      + 'sidecar, then plan again against a keystore nothing is writing.');
  }
  const resolved = {
    ...request,
    stateDir,
    backupSet,
    rootKeyId: rootKeyId(root),
    staticKeyId: keyLabel(staticKek),
    backupSetDigest: verification.setDigest,
    keystoreSetDigest: setDigest,
    keysProved: keys,
  };
  // FROZEN, AND SAID SO. A plan is what an operator confirmed; a caller able to edit one between the print
  // and the run would be editing the thing the digest binds.
  return Object.freeze({ ...resolved, planDigest: kekMigrationPlanDigest(resolved) });
}

/** Over where, which root, which static key, which exact keystore and which exact backup. */
export function kekMigrationPlanDigest(plan: Omit<ResolvedKekMigration, 'planDigest'>): string {
  return createHash('sha256').update(JSON.stringify({
    report: KEK_MIGRATION_REPORT,
    version: KEK_ROTATION_VERSION,
    stateDir: createHash('sha256').update(plan.stateDir, 'utf8').digest('hex'),
    rootKeyId: plan.rootKeyId,
    staticKeyId: plan.staticKeyId,
    backupSetDigest: plan.backupSetDigest,
    keystoreSetDigest: plan.keystoreSetDigest,
    keysProved: plan.keysProved,
  }), 'utf8').digest('hex');
}

export interface KekMigrationReport {
  readonly report: typeof KEK_MIGRATION_REPORT;
  readonly ok: boolean;
  readonly planDigest: string;
  readonly ring: KekRingSummary;
  readonly keysProved: number;
  readonly network: 'none';
  readonly notes: readonly string[];
}

/**
 * The seam that makes the concurrent-writer detection testable rather than merely written down.
 *
 * NOT PASSED ANYWHERE IN PRODUCTION. It stands for an ordinary custodian write landing while the adoption is
 * in flight — which is a thing that can happen, for the reason set out on `runKekMigration`.
 */
export interface KekMigrationFaults {
  readonly afterAdopt?: () => void;
}

/**
 * Adopt the static KEK, under the lock, having re-established everything the plan claimed.
 *
 * EVERY INPUT IS READ AGAIN INSIDE THE LOCK. The plan was computed against a moment that has passed: the
 * static key file can have been replaced, a key file can have been added to the keystore, the backup set can
 * have been rewritten at the same path, and a ring can have appeared. Recomputing the whole plan here and
 * comparing digests is what makes the operator's confirmation a statement about what is actually on disk.
 *
 * -----------------------------------------------------------------------------------------------------
 * TWO LOCKS, AND WHY NEITHER ALONE IS THE TRANSACTION.
 * -----------------------------------------------------------------------------------------------------
 *
 * `ROTATION_LOCK_DIRNAME` serialises the KEY OPERATIONS in this module — a rotation, a retirement, a root
 * re-seal, this migration. On its own it does NOT serialise the custodian: `FileCustodian.provision`,
 * `destroy` and `rewrapKeystore` write into `keys/` and knew nothing about it. An earlier version of this
 * command held only that lock and recomputed the key set afterwards, which narrows the window in which a
 * concurrent write invalidates the proof and CANNOT CLOSE IT — there is always a moment after the last check.
 *
 * So this also holds `CUSTODIAN_WRITER_LOCK`, which is the lock those writers now take, for the whole of the
 * re-read → prove → adopt sequence. While it is held, a provision, a destroy and a rewrap are REFUSED rather
 * than interleaved, and the set the adoption was justified by is the set that is still there when it
 * finishes. The post-adoption recheck below is KEPT as defence in depth — against a writer that predates this
 * lock, or one that does not go through the class at all — but it is no longer what the claim rests on.
 *
 * NO NESTING. Nothing inside takes either lock again: `adoptStaticKekAsRing` takes the RING writer lock,
 * which is a different directory, and the proofs read key files without locking.
 */
export function runKekMigration(
  request: KekMigrationRequest & { readonly confirmDigest: string | null },
  faults: KekMigrationFaults = {},
): KekMigrationReport {
  const first = planKekMigration(request);
  if (request.confirmDigest !== first.planDigest) {
    throw new MaintenanceRefused(
      'the digest you confirmed is not the digest of the migration this command just computed. Nothing was '
      + 'changed. Run with --plan, read it, and copy the digest from the plan you actually read.');
  }
  const lock = acquireLockDirectory(join(first.stateDir, ROTATION_LOCK_DIRNAME),
    'another key operation is already running against this sidecar state, or one was interrupted and left its '
    + 'lock behind.');
  // AND THE KEYSTORE'S OWN WRITER LOCK, which is what actually holds off a provision or a destroy. Taken
  // second and released first, in one order everywhere, so two commands cannot each hold half.
  let writers: StateLock;
  try {
    writers = acquireStateLock(first.stateDir, CUSTODIAN_WRITER_LOCK);
  } catch (err) {
    lock.release();
    throw new MaintenanceRefused(err instanceof CustodianStateError
      ? `${err.message} A migration cannot prove which wrapped keys it adopted a key for while something else `
        + 'is writing them. Nothing was changed.'
      : 'the keystore writer lock could not be taken, so nothing was changed.');
  }
  try {
    // ---- EVERY INPUT RE-READ INSIDE THE LOCK, INCLUDING THE KEY SET ---------------------------------------
    //
    // This is the whole reason the plan is a pure function: it can be recomputed. The absence of a ring, the
    // static key's bytes, the backup's own digest and the DIGEST OF THE EXACT SET OF WRAPPED KEY FILES are
    // all established again here, with BOTH locks held and without releasing either before the adoption. A
    // digest computed before the locks proves nothing on its own; a digest recomputed under them, compared
    // with the one the operator confirmed, is what makes their confirmation a statement about what is on
    // disk — and what keeps it true for the rest of this function.
    const resolved = planKekMigration(request);
    if (resolved.planDigest !== first.planDigest) {
      throw new MaintenanceRefused(
        'the static KEK, the keystore, the root key or the backup set changed between reading this plan and '
        + 'running it. Nothing was changed. Re-run with --plan against what is actually there.');
    }
    const root = readRootWrappingKey(request.rootKeyFile);
    const staticKek = readKeyFileNoFollow(request.staticKeyFile, 'static KEK');
    const ring = adoptStaticKekAsRing(resolved.stateDir, root, staticKek);
    faults.afterAdopt?.();
    // ---- AND THE SET IS STILL THE SET THE ADOPTION WAS JUSTIFIED BY ---------------------------------------
    assertKeySetUnmovedOrRollBack(resolved);
    return {
      report: KEK_MIGRATION_REPORT,
      ok: true,
      planDigest: resolved.planDigest,
      ring: summarizeKekRing(ring, root),
      keysProved: resolved.keysProved,
      network: 'none',
      notes: [
        'Nothing was re-wrapped and no key material changed: every wrapped DEK is under exactly the key it was '
        + 'under before. What changed is that the sidecar now reads a ring it can rotate instead of a static '
        + 'file it cannot.',
        'AFTER THIS, ROTATE. Until you do, the key protecting this installation is still the one that was in a '
        + 'file, and this command will not let a report say otherwise.',
        resolved.keysProved === 0
          ? 'This keystore held no wrapped keys, so the proof that the adopted key opens them covered nothing. '
            + 'That is a complete proof over an empty set and it is recorded as such rather than presented as '
            + 'an exhaustive one.'
          : `Every one of the ${resolved.keysProved} wrapped keys in this keystore was proved to open under the `
            + 'adopted key before the ring was written.',
      ],
    };
  } finally {
    // RELEASED IN THE REVERSE ORDER THEY WERE TAKEN.
    writers.release();
    lock.release();
  }
}

/**
 * After the ring is written: was it justified by the keystore that is actually there?
 *
 * DEFENCE IN DEPTH, NOT THE GUARANTEE. What holds a concurrent write off is the custodian writer lock this
 * command holds across the whole transaction. This check catches what a lock cannot: something writing into
 * `keys/` without going through `FileCustodian` at all. If the set moved anyway, the ring on disk is one whose
 * "every key opens under generation 1" proof covered a set that no longer exists — which is not a state to
 * leave behind and report success for, and not one to leave behind and report a refusal for either.
 *
 * SO THE ADOPTION IS UNDONE. The ring file is removed: this command proved under the lock that there was no
 * ring before it ran, so removing the one it wrote restores exactly the state it found. NOTHING IS LOST BY
 * DOING SO — generation 1 of that ring is the static KEK, which is still in the file it was read from, and no
 * key file was touched by the adoption. If the removal itself fails, BOTH facts go into the refusal, because
 * a ring left behind that nothing has re-proved is the more urgent of the two.
 */
function assertKeySetUnmovedOrRollBack(resolved: ResolvedKekMigration): void {
  let now: string;
  try {
    now = keystoreSetDigest(resolved.stateDir);
  } catch {
    now = '';
  }
  if (now === resolved.keystoreSetDigest) return;
  let removed = false;
  try {
    rmSync(kekRingPath(resolved.stateDir), { force: true });
    removed = !kekRingExists(resolved.stateDir);
  } catch {
    removed = false;
  }
  throw new MaintenanceRefused(removed
    ? 'a wrapped key in this keystore changed while the ring was being adopted, so the proof that every key '
      + 'opens under the adopted key covered a set that is no longer there. THE ADOPTION WAS UNDONE: there is '
      + 'no ring in this state directory and no key file was touched, which is exactly the state this command '
      + 'found. Quiesce the app and the sidecar, then run the migration again.'
    : 'a wrapped key in this keystore changed while the ring was being adopted, AND THE RING THAT WAS WRITTEN '
      + 'COULD NOT BE REMOVED AGAIN. There is now a ring in this state directory whose proof covered a set '
      + 'that is no longer there. Do not start the stack: check with `status` and, if the ring is not one you '
      + 'want, remove it and migrate again with the app and the sidecar stopped.');
}

/**
 * Every live wrapped key must open under the static KEK being adopted, or the adoption is refused.
 *
 * ADOPTING THE WRONG STATIC KEK PRODUCES A PERFECTLY WELL-FORMED RING THAT OPENS NOTHING. The migration would
 * report success, the sidecar would start, and every item in the catalog would read as unreadable — which is
 * indistinguishable from a correct erasure, so nothing would say why.
 *
 * Returns how many keys the proof covered, so a caller can record an empty keystore as the vacuous proof it
 * is rather than presenting it as an exhaustive one.
 */
export function assertStaticKekOpensKeystore(stateDir: string, staticKek: Buffer): number {
  let plan;
  try {
    plan = FileCustodian.planRewrapKeystore(stateDir, { fromKek: staticKek, toKek: staticKek });
  } catch (err) {
    // A KEYSTORE THIS BUILD WILL NOT WALK IS NOT A WRONG KEY, AND SAYING SO WOULD SEND AN OPERATOR TO THE
    // WRONG PLACE. The preflight refuses several things that have nothing to do with which key was named — a
    // `keys` directory that is a link, an entry nobody can account for, a key file filed under another key's
    // name — and this used to report every one of them as "the static KEK you named does not open ...". An
    // operator would have gone looking for a key file while their keystore held something they needed to see.
    const message = err instanceof Error ? err.message : '';
    if (!message.includes('does not unwrap under')) {
      throw new MaintenanceRefused(`${message === '' ? 'this keystore could not be read' : message}. Nothing `
        + 'was changed. That is a problem with the keystore rather than with the key you named: this command '
        + 'will not adopt a key against a set of wrapped keys it cannot state.');
    }
    throw new MaintenanceRefused(
      'the static KEK you named does not open the wrapped keys already in this keystore. Adopting it would '
      + 'produce a ring that opens NOTHING — and an item nothing can open is indistinguishable from a '
      + 'correctly erased one, so an installation would look empty rather than broken. Nothing was changed.');
  }
  if (plan.alreadyCurrent !== plan.total) {
    throw new MaintenanceRefused(
      'some wrapped keys in this keystore do not open under the static KEK you named. Nothing was changed.');
  }
  return plan.total;
}

/** The only shape a wrapped key file's name has: the custodian hashes every id into one. */
const KEYSTORE_FILE_NAME = /^[0-9a-f]{64}\.json$/;

/** How many wrapped keys this proof will walk. A bound, so a directory somebody grew is a refusal. */
export const MAX_KEYSTORE_ENTRIES = 100_000;

/**
 * A digest over the exact SET of wrapped key files, and over their contents.
 *
 * WHAT IT IS FOR. A plan says "every wrapped key in this keystore opens under the key you are adopting". That
 * is a statement about a SET of files, and it stops being true the moment the set changes. This digest is what
 * binds it: an added file, a removed file and a changed file each move the value, so a plan read at one moment
 * cannot be spent on a keystore that has moved since. None of the underlying bytes — which are wrapped DEKs —
 * is anywhere in the result.
 *
 * -----------------------------------------------------------------------------------------------------
 * AND IT READS THE KEYSTORE THE WAY THE REST OF THIS PRODUCT DOES, WHICH THE FIRST VERSION DID NOT.
 * -----------------------------------------------------------------------------------------------------
 *
 * That version was `readdirSync(...).filter(endsWith('.json')).map(readFileSync(join(...)))`. Four things
 * were wrong with it, and this is a PROOF path — the one place where being wrong is being wrong about which
 * files an adoption was justified by:
 *
 *   1. `readFileSync` FOLLOWS A LINK. A `keys/<hash>.json` replaced by a symlink to a file elsewhere was
 *      digested as though it were a key file, so the proof covered a file the keystore does not contain.
 *   2. A NAME ENDING IN `.json` IS NOT A KEY FILE. A directory, a fifo or a device with that suffix was
 *      passed to `readFileSync` as if it were one.
 *   3. NOTHING WAS BOUNDED. A file somebody grew was this process deciding to allocate whatever was on disk.
 *   4. ANYTHING NOT ENDING IN `.json` WAS SILENTLY IGNORED — including a `.tmp` left by a write that was
 *      interrupted, which is precisely the state in which the set is not settled.
 *
 * So every entry must be a name this custodian writes, must not be a kind of object that is not a regular
 * file, and is read through the bounded no-follow descriptor reader. An unexpected entry is a refusal rather
 * than something skipped: a keystore holding one is a keystore whose set nobody can state.
 *
 * IT RUNS BEFORE THE UNWRAP PROOF, DELIBERATELY. `FileCustodian.planRewrapKeystore` still reads key files by
 * path (hardening the custodian itself is its own change, with its own blast radius). Running this first means
 * the structural rejection happens before anything opens a key file by name.
 */
export function keystoreSetDigest(stateDir: string): string {
  const keysDir = join(stateDir, 'keys');
  // ---- THE DIRECTORY ITSELF, BEFORE ANYTHING IS LISTED FROM IT --------------------------------------------
  //
  // THE HOLE THIS CLOSES. Every per-entry check below is a no-follow check on a FILE. None of them says
  // anything about the directory the names came from: `readdirSync('<state>/keys')` follows a `keys` that is
  // a symlink, so this proof could have walked somebody else's directory with every individual entry passing.
  // The no-follow boundary escaped through the parent. The identity is taken again after the walk, so a
  // directory swapped underneath it is a refusal rather than a set digest over two different directories.
  let identity: StateDirectoryIdentity;
  try {
    identity = stateDirectoryIdentity(keysDir);
  } catch (err) {
    // A KEYSTORE DIRECTORY THAT HAS NEVER BEEN WRITTEN IS AN EMPTY SET, NOT A REFUSAL. Anything else about
    // that name — a link, a file, a permission problem — is a refusal, because it is not a keystore.
    if (err instanceof CustodianStateError && err.message.endsWith('is not there')) return keystoreDigestOf([]);
    throw new MaintenanceRefused(
      `the keystore in this sidecar state directory is not one this build will read (${err instanceof
        CustodianStateError ? err.message : 'it could not be opened'}), so the set of wrapped keys this `
      + 'operation would be justified by cannot be stated. Nothing was changed.');
  }
  let entries: readonly { readonly name: string; isFile(): boolean; isDirectory(): boolean;
    isSymbolicLink(): boolean; isFIFO(): boolean; isSocket(): boolean;
    isBlockDevice(): boolean; isCharacterDevice(): boolean }[];
  try {
    entries = readdirSync(keysDir, { withFileTypes: true });
  } catch {
    throw new MaintenanceRefused(
      'the keystore in this sidecar state directory could not be listed, so the set of wrapped keys this '
      + 'operation would be justified by cannot be stated. Nothing was changed.');
  }
  if (entries.length > MAX_KEYSTORE_ENTRIES) {
    throw new MaintenanceRefused('this keystore holds more entries than this build will walk. Nothing was changed.');
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!KEYSTORE_FILE_NAME.test(entry.name)) {
      throw new MaintenanceRefused(
        'this keystore holds an entry that is not a wrapped key file this custodian wrote — a leftover from an '
        + 'interrupted write, or something put there by hand. The set of keys an adoption would be justified '
        + 'by cannot be stated while it is there. Nothing was changed.');
    }
    // KNOWN-BAD KINDS ARE REFUSED HERE; the descriptor below refuses the rest. A filesystem that reports no
    // kind at all (some network mounts do) is not refused on that basis alone — it is refused, or not, by
    // what `fstat` says about the object actually opened, which is the answer that cannot be raced.
    if (entry.isDirectory() || entry.isSymbolicLink() || entry.isFIFO() || entry.isSocket()
      || entry.isBlockDevice() || entry.isCharacterDevice()) {
      throw new MaintenanceRefused(
        'this keystore holds an entry with a wrapped key file\'s name that is not a regular file. Nothing was '
        + 'changed.');
    }
    names.push(entry.name);
  }
  names.sort();
  const digested: Array<readonly [string, string]> = [];
  for (const name of names) {
    let bytes: Buffer;
    try {
      // BOUNDED, NO-FOLLOW, AND PROVED A REGULAR FILE ON THE DESCRIPTOR — the same reader every other piece
      // of custodian state goes through.
      bytes = readStateFileBytes(join(keysDir, name));
    } catch (err) {
      throw new MaintenanceRefused(
        `a wrapped key file in this keystore could not be read as one (${err instanceof CustodianStateError
          ? err.message : 'it could not be opened'}). Nothing was changed.`);
    }
    digested.push([name, createHash('sha256').update(bytes).digest('hex')]);
  }
  // ...AND IT WAS THE SAME DIRECTORY THROUGHOUT. Without this, "no link when I looked" is all the walk could
  // claim; with it, a `keys` swapped for another directory part-way is a refusal rather than a digest over
  // entries from two places.
  let after: StateDirectoryIdentity;
  try {
    after = stateDirectoryIdentity(keysDir);
  } catch {
    throw new MaintenanceRefused(
      'the keystore in this sidecar state directory stopped being readable while its key set was being read. '
      + 'Nothing was changed.');
  }
  if (after.dev !== identity.dev || after.ino !== identity.ino) {
    throw new MaintenanceRefused(
      'the keystore directory was replaced while its key set was being read, so the set this operation would '
      + 'be justified by is not the set that was walked. Nothing was changed.');
  }
  return keystoreDigestOf(digested);
}

function keystoreDigestOf(entries: readonly (readonly [string, string])[]): string {
  return createHash('sha256')
    .update(JSON.stringify(['phase-282-keystore-set', entries]), 'utf8')
    .digest('hex');
}

/** A non-reversible label for a key, used only to bind a plan digest. Never printed beside its key. */
function keyLabel(key: Buffer): string {
  return createHash('sha256').update('phase-282-key-label').update(key).digest('hex').slice(0, 32);
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
