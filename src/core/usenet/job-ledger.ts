import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { SealedValue } from './sealed.js';
import {
  USENET_DEDICATED_CATEGORY,
  isUsenetRefusalReason,
  submissionMarkerFor,
  type UsenetRefusalReason,
} from './sab-contract.js';

// Projection Phase 9 §3, THIRD DELIVERABLE — "a durable job ledger that survives process and host restarts
// without submitting the same job twice".
//
// THE PROBLEM IT SOLVES, STATED PRECISELY. A submission is a call that creates state on somebody else's
// machine and costs somebody money. It has three outcomes and only two of them are visible: accepted,
// refused, and ACCEPTED-BUT-THE-ANSWER-WAS-LOST. The third one is what makes "just retry it" wrong, and it is
// not rare — a control-plane restart, a container kill, a timeout on a busy worker all produce it.
//
// HOW IT IS SOLVED HERE, AND WHY THIS PARTICULAR WAY.
//
//   1. THE INTENT IS DURABLE BEFORE THE CALL. `reserve()` writes and fsyncs a record saying "I am about to
//      submit this" before the request is made. So after any crash, at any instant, the ledger either has no
//      record (nothing was submitted) or has a reservation (something MAY have been).
//
//   2. RECOVERY LOOKS RATHER THAN ASKS AGAIN. A reservation carries a MARKER — `projection-` plus the
//      submission key — which the submission sets as the job's name at the worker. A restart that finds a
//      reservation with no confirmed submission does not resubmit: it reads the queue and the history looking
//      for its own marker. Found means it was accepted and the answer was lost; absent means it was not.
//      That is the only way to distinguish those two, and it is why the marker exists at all.
//
//   3. THE KEY IS DERIVED FROM WHAT WAS SUBMITTED. Two submissions of the same NZB source into the same
//      category derive the same key, so the second one is refused by the ledger rather than by a human
//      noticing. An operator who genuinely wants the same source twice is told exactly what happened.
//
// WHAT THE FILE CONTAINS, AND WHAT IT DOES NOT. Never an NZB URL, never a release name, never a completed
// path, never an article id, never the worker's job id. Sealed values enter this module and only their
// FINGERPRINTS are written. That is checked by `test/usenet-job-ledger.ts`, which scans the written bytes.
//
// WHY APPEND-ONLY JSONL RATHER THAN A DATABASE TABLE. The control plane's PostgreSQL is a dependency this
// ledger must not have: the exactly-once claim has to hold across a restart in which the database is still
// starting, and a ledger that cannot be read until a database is up is a ledger that cannot answer "did I
// already submit this" at the moment it matters. Append-and-fsync is the smallest thing that is genuinely
// durable, and a replayed log has no partial-update state for a crash to land in.

export const USENET_LEDGER_VERSION = 1;
export const USENET_LEDGER_FILE = 'jobs.jsonl';

/**
 * A sub-directory, ALWAYS. `projectiond`'s cache directory deletes everything at its own top level on
 * startup, and an operator who points the ledger at a cache root would find the exactly-once guarantee
 * silently reset by the next daemon start. Nothing durable in this project lives at the top level of a
 * directory another component sweeps, and `usenetLedgerPath` is the enforcement of that rule rather than a
 * note about it.
 */
export const USENET_LEDGER_SUBDIR = 'usenet-ledger';

export function usenetLedgerPath(stateDir: string): string {
  return join(stateDir, USENET_LEDGER_SUBDIR, USENET_LEDGER_FILE);
}

// ---------------------------------------------------------------------------------------------------------
// Mutual exclusion
// ---------------------------------------------------------------------------------------------------------
//
// WHY A LOCK EXISTS AT ALL, WHEN THE APPEND IS ALREADY FSYNCED. Durability and exclusivity are different
// properties and this ledger needs both. `reserve()` decides whether to submit by reading the state it
// replayed WHEN IT OPENED, so two operator commands running at the same moment — `submit` typed twice, a
// `submit` racing the reconciliation timer the runbook puts on a schedule — both replay a ledger with no
// reservation, both append one, and both send the same NZB to the worker. That is the exact outcome the
// whole module exists to prevent, and no amount of fsync prevents it: each append is perfectly durable and
// there are two of them.
//
// IT IS ALSO WHAT KEEPS THE LEDGER READABLE. Two `reserved` records under one key is an invariant violation
// that replay refuses, correctly and permanently — so without exclusion the losing race does not merely
// double-submit, it leaves a ledger that no later command can open at all.
//
// THE LOCK IS A FILE CREATED WITH `wx`, which is atomic on every filesystem this appliance runs on, and it
// carries the holder's pid and start time so a lock left by a killed process can be identified rather than
// waited on forever. A lock older than the stale bound is broken with a written record of the breaking.

export const USENET_LEDGER_LOCK_FILE = 'jobs.lock';
/** How long a lock may be held before a later command treats its holder as dead. */
export const USENET_LEDGER_LOCK_STALE_MS = 15 * 60 * 1000;
/** How long a command waits for a live holder before refusing rather than queueing indefinitely. */
export const USENET_LEDGER_LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;

export function usenetLedgerLockPath(stateDir: string): string {
  return join(stateDir, USENET_LEDGER_SUBDIR, USENET_LEDGER_LOCK_FILE);
}

/**
 * Hold the ledger exclusively for the whole of one operator command.
 *
 * THE SCOPE IS THE COMMAND, NOT THE APPEND. Locking each append would make every individual write atomic and
 * still permit the interleaving above, because the decision to submit is made from state read before the
 * write. So the lock is taken before the ledger is opened and released after the last record is written, and
 * `openLedger` is called INSIDE it.
 */
export async function withUsenetLedgerLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
  options: { readonly waitMs?: number; readonly staleMs?: number; readonly now?: () => number } = {},
): Promise<T> {
  const path = usenetLedgerLockPath(stateDir);
  const now = options.now ?? (() => Date.now());
  const waitMs = options.waitMs ?? USENET_LEDGER_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? USENET_LEDGER_LOCK_STALE_MS;
  const deadline = now() + waitMs;

  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx');
    } catch {
      fd = undefined;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() })}\n`, null, 'utf8');
      } finally {
        closeSync(fd);
      }
      try {
        return await fn();
      } finally {
        // THE LOCK IS RELEASED ON EVERY PATH, INCLUDING A THROW. A command that failed still has to leave the
        // ledger usable by the next one; a lock that only unlocked on success would turn one bad submission
        // into a control plane that cannot submit again for fifteen minutes.
        try { rmSync(path, { force: true }); } catch { /* the stale bound is the backstop */ }
      }
    }

    let ageMs = 0;
    try {
      ageMs = now() - statSync(path).mtimeMs;
    } catch {
      // The holder released it between the failed create and this stat. Try again immediately.
      continue;
    }
    if (ageMs > staleMs) {
      // A LOCK OLDER THAN THE BOUND IS BROKEN, AND ONLY THEN. A control plane whose process was killed mid
      // command must not wedge every later one, and a bound this long cannot be reached by a command that is
      // merely slow: the longest thing done under this lock is one reconciliation pass.
      try { rmSync(path, { force: true }); } catch { /* another waiter won the race; the loop retries */ }
      continue;
    }
    if (now() >= deadline) {
      throw new LedgerError('LEDGER_LOCKED',
        'another projection Usenet command is holding the job ledger; exactly-once submission depends on one '
        + 'command at a time, so this one refused rather than reading a ledger that is being written');
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, LOCK_POLL_MS); });
  }
}

const SUBMISSION_KEY_DOMAIN = 'projection.phase9.submission.v1';

/** `<32 hex>`, derived from the sealed source and the category. Two identical submissions derive one key. */
export function deriveSubmissionKey(sealedSource: SealedValue, category: string = USENET_DEDICATED_CATEGORY): string {
  if (sealedSource.kind !== 'nzb-source') {
    throw new LedgerError('SUBMISSION_SOURCE_INVALID', 'a submission key is derived from a sealed NZB source');
  }
  return createHash('sha256')
    .update(`${SUBMISSION_KEY_DOMAIN}\n${category}\n${sealedSource.reveal()}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export class LedgerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'LedgerError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// The record shapes
// ---------------------------------------------------------------------------------------------------------

export const USENET_LEDGER_EVENTS = Object.freeze([
  'reserved',
  'submitted',
  'submission-lost',
  'observed',
  'admitted',
  'refused',
] as const);

export type UsenetLedgerEvent = (typeof USENET_LEDGER_EVENTS)[number];

export interface LedgerRecord {
  readonly v: number;
  readonly at: string;
  readonly key: string;
  readonly event: UsenetLedgerEvent;
  readonly marker: string;
  readonly category: string;
  /** The sealed source's fingerprint. Twelve hex characters; not the source. */
  readonly sourceFingerprint: string;
  /**
   * The catalog record an admitted entry will belong to — the manifest's `logicalMediaId`.
   *
   * IT IS CATALOG IDENTITY, NOT CONTENT IDENTITY. A `logicalMediaId` is an opaque UUID that already appears
   * in every published manifest; recording it here leaks nothing that the artifact does not already carry,
   * and NOT recording it would mean a restart could not finish an admission it had already reserved.
   */
  readonly itemId?: string;
  /** The worker job reference's fingerprint, once one is known. Never the reference. */
  readonly jobFingerprint?: string;
  /** On `observed`: the lifecycle word the worker's state mapped to. */
  readonly state?: string;
  /** On `admitted`: the proof, and the only place a digest is recorded. */
  readonly sha256?: string;
  readonly sizeBytes?: number;
  readonly projectedPath?: string;
  readonly versionKey?: string;
  readonly projectedEntryId?: string;
  /** On `refused`: the closed-set reason, and whether looking again could change it. */
  readonly reason?: UsenetRefusalReason;
  readonly transient?: boolean;
}

/** The current state of one submission, folded from its records. */
export interface LedgerJob {
  readonly key: string;
  readonly marker: string;
  readonly category: string;
  readonly sourceFingerprint: string;
  readonly itemId: string | null;
  readonly jobFingerprint: string | null;
  /** `reserved` until a submission is confirmed; then `submitted`; then a terminal state. */
  readonly phase: 'reserved' | 'submitted' | 'admitted' | 'refused';
  readonly lastObservedState: string | null;
  readonly admitted: {
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly projectedPath: string;
    readonly versionKey: string;
    readonly projectedEntryId: string;
    readonly at: string;
  } | null;
  readonly refusal: { readonly reason: UsenetRefusalReason; readonly transient: boolean; readonly at: string } | null;
  readonly reservedAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------------------

/**
 * Everything the ledger needs from a durable medium, and nothing more.
 *
 * `append` MUST NOT RETURN UNTIL THE BYTES ARE ON THE DEVICE. That is the entire contract: a `reserve()` that
 * returns before its record is durable is a `reserve()` that a power cut can undo, and undoing it is exactly
 * the double submission this ledger exists to prevent. The file implementation fsyncs the file and, on
 * creation, the directory.
 */
export interface LedgerStorage {
  readAll(): readonly string[];
  append(line: string): void;
}

export function createFileLedgerStorage(path: string): LedgerStorage {
  const directory = dirname(path);
  return {
    readAll(): readonly string[] {
      if (!existsSync(path)) return [];
      const text = readFileSync(path, 'utf8');
      if (text.length === 0) return [];
      // A TORN TRAILING LINE IS DROPPED; ANYTHING ELSE IS A REFUSAL. A crash during an append can leave a
      // partial last line, and that is the one corruption this format can recover from honestly, because the
      // record it represents had not been acknowledged to any caller. A malformed line in the MIDDLE means
      // the file was edited or damaged, and replaying past it would silently forget a submission.
      //
      // The last element of the split is dropped either way, and deliberately: on a complete file it is the
      // empty string after the final newline, and on a torn file it is the unterminated record.
      return text.split('\n').slice(0, -1);
    },
    append(line: string): void {
      mkdirSync(directory, { recursive: true });
      const existed = existsSync(path);
      const fd = openSync(path, 'a');
      try {
        writeSync(fd, `${line}\n`, null, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (!existed) {
        // The FILE's bytes being durable does not make its NAME durable. On a crash between the two, the
        // record exists and nothing can find it.
        try {
          const dirFd = openSync(directory, 'r');
          try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
        } catch {
          // Windows refuses to open a directory for fsync. The file's own fsync still happened, and this
          // project's durability claim is made about the Unraid host it deploys to.
        }
      }
    },
  };
}

/** An in-memory storage, for tests and for a dry run. Not durable, and it says so in its name. */
export function createMemoryLedgerStorage(seed: readonly string[] = []): LedgerStorage & { lines(): readonly string[] } {
  const lines: string[] = [...seed];
  return {
    readAll: () => [...lines],
    append: (line) => { lines.push(line); },
    lines: () => [...lines],
  };
}

// ---------------------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------------------

export interface LedgerClock {
  nowIso(): string;
}

export const systemLedgerClock: LedgerClock = { nowIso: () => new Date().toISOString() };

const KEY_SHAPE = /^[0-9a-f]{32}$/;
const FINGERPRINT_SHAPE = /^[0-9a-f]{12}$/;
const SHA256_SHAPE = /^[0-9a-f]{64}$/;
const CATEGORY_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class UsenetJobLedger {
  private readonly storage: LedgerStorage;
  private readonly clock: LedgerClock;
  private readonly jobs = new Map<string, LedgerJob>();

  private constructor(storage: LedgerStorage, clock: LedgerClock) {
    this.storage = storage;
    this.clock = clock;
  }

  /** Open a ledger by replaying it. A file that cannot be replayed is a refusal, never a fresh start. */
  static open(storage: LedgerStorage, clock: LedgerClock = systemLedgerClock): UsenetJobLedger {
    const ledger = new UsenetJobLedger(storage, clock);
    const lines = storage.readAll();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] as string;
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new LedgerError('LEDGER_LINE_MALFORMED', `the job ledger has an unreadable record at line ${index + 1}`);
      }
      ledger.apply(validateRecord(parsed, index + 1));
    }
    return ledger;
  }

  all(): readonly LedgerJob[] {
    return [...this.jobs.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  get(key: string): LedgerJob | undefined {
    return this.jobs.get(key);
  }

  /**
   * Record the intent to submit, durably, BEFORE the submission is attempted.
   *
   * Returns the existing job when one is already recorded, so a caller that reserves twice learns that rather
   * than getting a second reservation. The caller decides what to do about it; the ledger does not guess.
   */
  reserve(input: {
    readonly sealedSource: SealedValue;
    readonly category?: string;
    /** The catalog record the admitted entry will belong to. Required before an admission can be published. */
    readonly itemId?: string;
  }): { readonly created: boolean; readonly job: LedgerJob } {
    const category = input.category ?? USENET_DEDICATED_CATEGORY;
    if (!CATEGORY_SHAPE.test(category)) {
      throw new LedgerError('LEDGER_CATEGORY_INVALID', 'a category is a plain label');
    }
    if (input.itemId !== undefined && !UUID_SHAPE.test(input.itemId)) {
      throw new LedgerError('LEDGER_ITEM_ID_INVALID', 'a catalog record is named by a UUID');
    }
    const key = deriveSubmissionKey(input.sealedSource, category);
    const existing = this.jobs.get(key);
    if (existing !== undefined) return { created: false, job: existing };

    const record: LedgerRecord = {
      v: USENET_LEDGER_VERSION,
      at: this.clock.nowIso(),
      key,
      event: 'reserved',
      marker: submissionMarkerFor(key),
      category,
      sourceFingerprint: input.sealedSource.fingerprint(),
      ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    };
    this.write(record);
    return { created: true, job: this.jobs.get(key) as LedgerJob };
  }

  /** The submission was accepted and the worker's answer was received. */
  confirmSubmitted(key: string, jobRef: SealedValue): LedgerJob {
    const job = this.require(key);
    if (job.phase === 'admitted') return job;
    this.write({ ...this.base(job, 'submitted'), jobFingerprint: jobRef.fingerprint() });
    return this.require(key);
  }

  /**
   * A reservation whose submission was PROVED not to have reached the worker.
   *
   * "Proved" means a reconciliation read the queue and the history and found no job carrying this marker. It
   * is written down rather than simply forgotten, so that a ledger a human reads records the ambiguity and
   * how it was resolved — and so that a second reservation of the same key is a deliberate act with a record
   * before it rather than a silent re-run.
   */
  recordSubmissionLost(key: string): LedgerJob {
    const job = this.require(key);
    if (job.phase !== 'reserved') {
      throw new LedgerError('LEDGER_STATE_CONFLICT', 'only an unconfirmed reservation can be recorded as lost');
    }
    this.write(this.base(job, 'submission-lost'));
    return this.require(key);
  }

  /**
   * What the worker most recently said, folded to the operator-visible lifecycle. Advisory; never terminal.
   *
   * AN UNCHANGED OBSERVATION WRITES NOTHING. Reconciliation runs on a timer, and a four-hour download
   * observed every ten minutes would otherwise append twenty-four identical records saying `downloading` —
   * a ledger that grows with elapsed time rather than with events, and whose replay cost grows with it.
   */
  recordObserved(key: string, state: string, jobRef?: SealedValue): LedgerJob {
    const job = this.require(key);
    if (job.phase === 'admitted') return job;
    const unchanged = job.lastObservedState === state
      && job.refusal === null
      && (jobRef === undefined || job.jobFingerprint === jobRef.fingerprint());
    if (unchanged) return job;
    this.write({
      ...this.base(job, 'observed'),
      state,
      ...(jobRef ? { jobFingerprint: jobRef.fingerprint() } : {}),
    });
    return this.require(key);
  }

  /**
   * THE EXACTLY-ONCE POINT OF THE WHOLE TRANCHE.
   *
   * A second admission of the same submission with the same proof is an idempotent no-op and reports itself
   * as `already-admitted`. A second admission with a DIFFERENT proof is a refusal: the same job cannot have
   * produced two different byte streams, so one of the two readings is wrong, and publishing either would put
   * a projected version's identity in doubt.
   */
  recordAdmitted(key: string, admission: {
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly projectedPath: string;
    readonly versionKey: string;
    readonly projectedEntryId: string;
  }): { readonly admitted: boolean; readonly job: LedgerJob; readonly reason?: UsenetRefusalReason } {
    const job = this.require(key);
    if (!SHA256_SHAPE.test(admission.sha256)) {
      throw new LedgerError('LEDGER_DIGEST_INVALID', 'an admission records a 64-character lower-case digest');
    }
    if (!Number.isSafeInteger(admission.sizeBytes) || admission.sizeBytes <= 0) {
      throw new LedgerError('LEDGER_SIZE_INVALID', 'an admission records an exact positive byte length');
    }
    if (job.admitted !== null) {
      const same = job.admitted.sha256 === admission.sha256
        && job.admitted.sizeBytes === admission.sizeBytes
        && job.admitted.projectedPath === admission.projectedPath;
      return same
        ? { admitted: false, job, reason: 'already-admitted' }
        : { admitted: false, job, reason: 'admitted-digest-mismatch' };
    }
    if (job.phase === 'reserved') {
      // Admitting something that was never confirmed submitted would mean the control plane found an output
      // it cannot tie to a submission it made.
      return { admitted: false, job, reason: 'submission-not-reserved' };
    }
    this.write({ ...this.base(job, 'admitted'), ...admission });
    return { admitted: true, job: this.require(key) };
  }

  /** A refusal, with its reason and whether looking again could change the answer. */
  recordRefused(key: string, reason: UsenetRefusalReason, transient: boolean): LedgerJob {
    const job = this.require(key);
    if (job.phase === 'admitted') {
      // AN ADMITTED ENTRY IS NEVER UNPUBLISHED BY A LATER REFUSAL. §1: a Usenet failure shall not empty,
      // rename or make unavailable any already-admitted entry. The refusal is dropped rather than recorded,
      // because recording it would leave a ledger whose last word about a live entry is "refused".
      return job;
    }
    // THE SAME REFUSAL TWICE IS ONE REFUSAL. A permanently refused job stays refused for the same reason
    // every time anything looks at it; appending a record per look would make the ledger grow with the
    // frequency of the timer rather than with what happened.
    if (job.refusal !== null && job.refusal.reason === reason && job.refusal.transient === transient) {
      return job;
    }
    this.write({ ...this.base(job, 'refused'), reason, transient });
    return this.require(key);
  }

  /**
   * Clear a TRANSIENT refusal so reconciliation can look again.
   *
   * A permanent refusal cannot be cleared here. An operator who wants one retried changes what was wrong and
   * submits again, which derives a new reservation through the ordinary path.
   */
  clearTransientRefusal(key: string): LedgerJob {
    const job = this.require(key);
    if (job.refusal === null) return job;
    if (!job.refusal.transient) {
      throw new LedgerError('LEDGER_STATE_CONFLICT', 'a permanent refusal is not cleared by looking again');
    }
    this.write({ ...this.base(job, 'observed'), state: 'ready-to-admit' });
    return this.require(key);
  }

  private base(job: LedgerJob, event: UsenetLedgerEvent): LedgerRecord {
    return {
      v: USENET_LEDGER_VERSION,
      at: this.clock.nowIso(),
      key: job.key,
      event,
      marker: job.marker,
      category: job.category,
      sourceFingerprint: job.sourceFingerprint,
      ...(job.jobFingerprint === null ? {} : { jobFingerprint: job.jobFingerprint }),
    };
  }

  private require(key: string): LedgerJob {
    const job = this.jobs.get(key);
    if (job === undefined) throw new LedgerError('LEDGER_UNKNOWN_JOB', 'no submission is recorded under that key');
    return job;
  }

  private write(record: LedgerRecord): void {
    // THE RECORD IS DURABLE BEFORE THE IN-MEMORY STATE MOVES. The other order would let a caller observe a
    // transition that a crash one instruction later would erase.
    this.storage.append(JSON.stringify(record));
    this.apply(record);
  }

  private apply(record: LedgerRecord): void {
    const existing = this.jobs.get(record.key);
    if (record.event === 'reserved') {
      if (existing !== undefined) {
        // A SECOND RESERVATION AFTER A LOST SUBMISSION IS LEGITIMATE; one over a live job is not.
        if (existing.phase !== 'refused') {
          // THE MESSAGE NAMES THE CAUSE, because this is the one refusal an operator meets with a ledger
          // that will not open at all. Two `reserved` records under one key can only be written by two
          // commands that ran at the same moment against the same state directory — which
          // `withUsenetLedgerLock` now prevents, and which a ledger written before that lock existed, or one
          // reached through two different state directories pointing at one file, could still hold.
          throw new LedgerError('LEDGER_DUPLICATE_RESERVATION',
            'the ledger reserves a submission key once, and this one is reserved twice — which means two '
            + 'control-plane commands ran against it at the same moment, so the same source may have been '
            + 'submitted twice. Read the worker\'s own history for the marker before removing either record.');
        }
      }
      this.jobs.set(record.key, {
        key: record.key,
        marker: record.marker,
        category: record.category,
        sourceFingerprint: record.sourceFingerprint,
        itemId: record.itemId ?? null,
        jobFingerprint: null,
        phase: 'reserved',
        lastObservedState: null,
        admitted: null,
        refusal: null,
        reservedAt: record.at,
        updatedAt: record.at,
      });
      return;
    }

    if (existing === undefined) {
      throw new LedgerError('LEDGER_ORPHAN_RECORD', 'the ledger records an event for a submission it never reserved');
    }

    const next: LedgerJob = {
      ...existing,
      jobFingerprint: record.jobFingerprint ?? existing.jobFingerprint,
      updatedAt: record.at,
    };

    switch (record.event) {
      case 'submitted':
        this.jobs.set(record.key, { ...next, phase: 'submitted', refusal: null });
        return;
      case 'submission-lost':
        // IT RESETS TO "AS IF NEVER ATTEMPTED", and that is the whole point of writing it down. A
        // reservation whose submission was PROVED not to have reached the worker is one an operator may
        // safely submit again; leaving an observation on it would make the retry look like a duplicate and
        // wedge the submission permanently, which is worse than the ambiguity it was resolving.
        this.jobs.set(record.key, {
          ...next, phase: 'reserved', jobFingerprint: null, lastObservedState: null, refusal: null,
        });
        return;
      case 'observed':
        this.jobs.set(record.key, {
          ...next,
          lastObservedState: record.state ?? next.lastObservedState,
          refusal: null,
        });
        return;
      case 'admitted':
        this.jobs.set(record.key, {
          ...next,
          phase: 'admitted',
          refusal: null,
          admitted: {
            sha256: record.sha256 as string,
            sizeBytes: record.sizeBytes as number,
            projectedPath: record.projectedPath as string,
            versionKey: record.versionKey as string,
            projectedEntryId: record.projectedEntryId as string,
            at: record.at,
          },
        });
        return;
      case 'refused':
        this.jobs.set(record.key, {
          ...next,
          phase: 'refused',
          refusal: { reason: record.reason as UsenetRefusalReason, transient: record.transient === true, at: record.at },
        });
        return;
      default:
        throw new LedgerError('LEDGER_EVENT_UNKNOWN', 'the ledger holds an event this version does not define');
    }
  }
}

/**
 * Validate one replayed record, strictly.
 *
 * A ledger is only worth what its weakest read is. A record that is accepted loosely — a missing key, an
 * unknown event, a digest that is not a digest — becomes state that the exactly-once check then trusts.
 */
function validateRecord(raw: unknown, line: number): LedgerRecord {
  const at = `line ${line}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LedgerError('LEDGER_LINE_MALFORMED', `the job ledger record at ${at} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  if (record['v'] !== USENET_LEDGER_VERSION) {
    throw new LedgerError('LEDGER_VERSION_UNKNOWN', `the job ledger record at ${at} is a version this build cannot read`);
  }
  const event = record['event'];
  if (typeof event !== 'string' || !(USENET_LEDGER_EVENTS as readonly string[]).includes(event)) {
    throw new LedgerError('LEDGER_EVENT_UNKNOWN', `the job ledger record at ${at} names an unknown event`);
  }
  const key = record['key'];
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) {
    throw new LedgerError('LEDGER_KEY_INVALID', `the job ledger record at ${at} has no usable submission key`);
  }
  const marker = record['marker'];
  if (typeof marker !== 'string' || marker !== submissionMarkerFor(key)) {
    throw new LedgerError('LEDGER_MARKER_INVALID', `the job ledger record at ${at} has a marker its key does not derive`);
  }
  const category = record['category'];
  if (typeof category !== 'string' || !CATEGORY_SHAPE.test(category)) {
    throw new LedgerError('LEDGER_CATEGORY_INVALID', `the job ledger record at ${at} has no usable category`);
  }
  const sourceFingerprint = record['sourceFingerprint'];
  if (typeof sourceFingerprint !== 'string' || !FINGERPRINT_SHAPE.test(sourceFingerprint)) {
    throw new LedgerError('LEDGER_FINGERPRINT_INVALID', `the job ledger record at ${at} has no usable source fingerprint`);
  }
  const timestamp = record['at'];
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    throw new LedgerError('LEDGER_TIMESTAMP_INVALID', `the job ledger record at ${at} has no usable timestamp`);
  }
  const itemId = record['itemId'];
  if (itemId !== undefined && (typeof itemId !== 'string' || !UUID_SHAPE.test(itemId))) {
    throw new LedgerError('LEDGER_ITEM_ID_INVALID', `the job ledger record at ${at} has an unusable catalog record id`);
  }
  const jobFingerprint = record['jobFingerprint'];
  if (jobFingerprint !== undefined && (typeof jobFingerprint !== 'string' || !FINGERPRINT_SHAPE.test(jobFingerprint))) {
    throw new LedgerError('LEDGER_FINGERPRINT_INVALID', `the job ledger record at ${at} has an unusable job fingerprint`);
  }

  if (event === 'admitted') {
    const sha256 = record['sha256'];
    const sizeBytes = record['sizeBytes'];
    if (typeof sha256 !== 'string' || !SHA256_SHAPE.test(sha256)) {
      throw new LedgerError('LEDGER_DIGEST_INVALID', `the admission at ${at} carries no usable digest`);
    }
    if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) <= 0) {
      throw new LedgerError('LEDGER_SIZE_INVALID', `the admission at ${at} carries no usable byte length`);
    }
    for (const field of ['projectedPath', 'versionKey', 'projectedEntryId']) {
      const value = record[field];
      if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
        throw new LedgerError('LEDGER_ADMISSION_INCOMPLETE', `the admission at ${at} is missing ${field}`);
      }
    }
  }
  if (event === 'refused' && !isUsenetRefusalReason(record['reason'])) {
    throw new LedgerError('LEDGER_REASON_INVALID', `the refusal at ${at} names a reason this contract does not define`);
  }

  return record as unknown as LedgerRecord;
}
