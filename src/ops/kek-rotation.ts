import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FileCustodian } from '../core/crypto/file-custodian.js';
import {
  KEK_RING_DIRNAME,
  KekRingError,
  activatePendingGeneration,
  activeKek,
  beginPendingGeneration,
  kekForGeneration,
  loadKekRing,
  readRootWrappingKey,
  retireGeneration,
  rootKeyId,
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
  }), 'utf8').digest('hex');
}

export function rotationJournalPath(stateDir: string): string {
  return join(stateDir, KEK_RING_DIRNAME, ROTATION_JOURNAL_NAME);
}

export function readRotationJournal(stateDir: string): RotationJournal | null {
  const journal = readStateDocument<RotationJournal>(rotationJournalPath(stateDir));
  if (journal === null) return null;
  if (journal.rotation !== KEK_ROTATION_REPORT || journal.version !== KEK_ROTATION_VERSION
    || typeof journal.planDigest !== 'string' || !ROTATION_STAGES.includes(journal.stage)) {
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

  // ---- A COMPLETE BACKUP THAT VERIFIES, BEFORE A BYTE MOVES ---------------------------------------------
  const verification = verifyBackupSet(resolved.backupSet);
  if (!verification.ok) {
    throw new MaintenanceRefused(
      'the complete backup this rotation would fall back to does not verify. A rotation rewrites every wrapped '
      + 'key in the installation; without a set that verifies NOW there is nothing to go back to. Nothing was '
      + 'changed.');
  }

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

  try {
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
      stage = journal.stage;
      toGeneration = journal.toGeneration;
    }

    // ---- QUIESCE -----------------------------------------------------------------------------------------
    for (const service of ROTATION_QUIESCED_SERVICES) {
      const stop = runGuarded(deps.runner, deps.ledger, composeCommand(resolved, ['stop', service],
        `stop ${service} so nothing writes while every wrapped key is rewritten`));
      if (stop.status !== 0) {
        throw new MaintenanceRefused(
          `the ${service} service could not be stopped, so a rotation would run against a live writer. Nothing `
          + 'was changed.');
      }
      quiesced.push(service);
    }

    try {
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
    } finally {
      // ALWAYS, on every path out: a refusal, a throw, a success. The same rule as the backup's window, and
      // for the same reason — a command that leaves the stack down has caused the outage it was insurance
      // against. Every service that WAS stopped gets an attempt, in reverse order.
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
export function retireKekGeneration(
  request: { readonly stateDir: string; readonly rootKeyFile: string; readonly backupSet: string; readonly generation: number },
): { readonly ok: boolean; readonly ring: KekRingSummary; readonly notes: readonly string[] } {
  const stateDir = resolveMaintenanceRoot(request.stateDir, 'sidecar state directory');
  const backupSet = resolveMaintenanceRoot(request.backupSet, 'backup set directory');
  const verification = verifyBackupSet(backupSet);
  if (!verification.ok) {
    throw new MaintenanceRefused(
      'the complete backup you named does not verify, so retiring a generation now would remove the only key '
      + 'that can open the sets you already have. Nothing was changed.');
  }
  const root = readRootWrappingKey(request.rootKeyFile);
  const before = loadKekRing(stateDir, root);
  // THE BACKUP MUST BE ONE TAKEN AFTER THE ROTATION, and this is how that is established without trusting a
  // timestamp somebody could set: the set must hold a keystore whose keys read under the ACTIVE generation.
  const active = activeKek(before);
  const staged = join(backupSet, 'keystore-backup');
  if (existsSync(staged)) {
    // A KEY THE ACTIVE GENERATION CANNOT OPEN MEANS THE SET PREDATES THE ROTATION. `planRewrapKeystore`
    // reports that either by counting or by refusing outright — a keystore where nothing opens under the key
    // it was given is exactly the "wrong key" case it throws on — and both answers mean the same thing here.
    let current = false;
    try {
      const plan = FileCustodian.planRewrapKeystore(staged, { fromKek: active, toKek: active });
      current = plan.alreadyCurrent === plan.total;
    } catch {
      current = false;
    }
    if (!current) {
      throw new MaintenanceRefused(
        'the backup you named holds keys that do NOT read under the current generation, so it was taken BEFORE '
        + 'this rotation. Retiring the outgoing generation would make it unrestorable. Take a backup now, '
        + 'verify it, and retire against that one.');
    }
  }
  const after = retireGeneration(stateDir, root, request.generation);
  return {
    ok: true,
    ring: summarizeKekRing(after, root),
    notes: [
      'That generation is gone from the ring. Any backup taken while it was active can no longer be restored '
      + 'by this installation, which is what retirement means and is why it is a separate command.',
    ],
  };
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
