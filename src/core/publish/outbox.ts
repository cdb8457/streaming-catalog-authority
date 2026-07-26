import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { CatalogAuthority } from '../catalog/authority.js';
import type { PublishableField, PublishableIdentity } from '../adapters/publisher.js';
import { assertPublishAllowed, type PublishConsent } from './consent.js';
import {
  planPublish, lockIntent, markInFlight, markAmbiguous, settleIntent, markFailed,
  listActionableIntents, recordRecoveryProof, latestRecoveryProof, type PublishLedgerRow, type Db,
} from './ledger.js';

/**
 * Phase 12 — durable publish-intent OUTBOX. Makes a remote create orphan-safe:
 *  1. write a durable 'planned' intent (identity-free, opaque `token`) BEFORE any side effect;
 *  2. tag the created artifact with the same `token`;
 *  3. recover by TOKEN — the durable token, NOT the (possibly-lost) response handle, is the source of
 *     truth. reconcile() searches the target for the token: found → adopt the handle (published);
 *     not found → (re)create within a bounded budget, else fail. Result: at every crash point an
 *     intent ends TRACKED (revocable) or provably GONE — never an untracked/unrevocable orphan.
 *
 * Phase 261 — step (3) is only sound while the token written in step (2) can actually be read back, and
 * nothing used to check that. Every create now PROVES its own artifact is findable by its token
 * ({@link RecoveryProof}); the first create that is not turns "not found" from proof-of-absence into
 * proof-of-nothing, and reconcile() stops (re)creating rather than duplicating what it can no longer see.
 */

/** The external artifact operations the outbox drives, keyed on an opaque correlation token. */
export interface OutboxTarget {
  readonly name: string;
  /** Create the external artifact tagged with `token`, from the MINIMIZED identity. Returns the opaque
   *  handle; throws on failure (the outbox recovers by token, never by this possibly-lost return). */
  create(identity: PublishableIdentity, token: string): Promise<string>;
  /** Recovery/idempotency: find the artifact tagged with `token`; its handle, or null if none. */
  findByToken(token: string): Promise<string | null>;
}

export type OutboxOutcome = 'published' | 'ambiguous' | 'skipped';

/**
 * Phase 261 — what a create proved about RECOVERABILITY, which is a different question from whether the
 * create succeeded:
 *  - `verified`      the artifact we just made is findable by its own token. Recovery works.
 *  - `unrecoverable` the create returned a handle, but the token does NOT find it. The marker did not
 *                    survive the round trip, so a later "not found" is NOT proof of absence.
 *  - `contradictory` the token finds a DIFFERENT artifact than the one we just created.
 *  - `unknown`       the create failed, or the verifying lookup itself failed. Nothing was learned.
 */
export type RecoveryProof = 'verified' | 'unrecoverable' | 'contradictory' | 'unknown';

export interface OutboxResult { intentId: string; status: OutboxOutcome; handle?: string; recovery?: RecoveryProof; }
export interface ReconcileResult { adopted: number; created: number; failed: number; stuck: number; }

const MAX_ATTEMPTS = 5;
const ACTIONABLE = new Set(['planned', 'in_flight', 'ambiguous']);
/** A correlation token is written into an external artifact and later matched back out of it, so it must
 *  be bounded and free of control characters before it is ever persisted or sent. */
const TOKEN_MAX = 128;

export class OutboxService {
  /**
   * Set the moment a create through THIS service is observed to be UNRECOVERABLE or CONTRADICTORY (see
   * {@link RecoveryProof}). Once recovery is known broken for a target, `findByToken() === null` can no
   * longer be read as "the artifact does not exist", so reconcile() must never (re)create again — that is
   * exactly how one lost response becomes a run of duplicate external collections.
   *
   * In-memory is NOT enough on its own: the process that publishes is not the process that reconciles, so
   * every proof is also written to the ledger and re-read at the start of each pass. This field only
   * covers the window inside a single pass, where re-reading per intent would be wasted work.
   */
  private recoveryBroken = false;

  constructor(
    private readonly pool: Pool,
    private readonly auth: CatalogAuthority,
    private readonly consent: PublishConsent,
    private readonly target: OutboxTarget,
    private readonly requires: readonly PublishableField[],
    private readonly newToken: () => string = randomUUID,
  ) {}

  /** Whether a create through this service has proved the target's token recovery to be broken. */
  isRecoveryBroken(): boolean { return this.recoveryBroken; }

  /** Consent-gated. Plan a durable intent, then attempt the create once. Recovery is via reconcile(). */
  async publish(itemId: string, opts: { dryRun?: boolean } = {}): Promise<OutboxResult> {
    const dryRun = opts.dryRun ?? true;
    assertPublishAllowed(this.consent, dryRun); // live create refused unless consent=allow
    if (dryRun) return { intentId: '', status: 'skipped' }; // dry-run: no intent, no side effect
    const token = assertUsableToken(this.newToken());
    const intentId = await planPublish(this.pool, { itemId, target: this.target.name, token, disclosedFields: this.requires });
    return this.attemptCreate(intentId, token, itemId);
  }

  private async attemptCreate(intentId: string, token: string, itemId: string): Promise<OutboxResult> {
    await markInFlight(this.pool, intentId);
    const { handle, recovery } = await this.createAndProve(this.pool, intentId, itemId, token);
    // A created artifact is settled even when its recoverability could not be proved: we HOLD its handle,
    // so recording it keeps it tracked and revocable. Discarding the handle here would be the orphan.
    if (handle !== null && (await settleIntent(this.pool, intentId, handle))) {
      return { intentId, status: 'published', handle, recovery };
    }
    // create failed / response lost / item not disclosable -> ambiguous; reconcile() recovers by token.
    await markAmbiguous(this.pool, intentId);
    return { intentId, status: 'ambiguous', recovery };
  }

  /**
   * Create the external artifact, then PROVE it is findable by its own token before anything is allowed to
   * treat a future "not found" as absence.
   *
   * The outbox's whole duplicate-prevention property rests on one assumption: the token written at create
   * time can be read back at recovery time. Nothing used to check it. When the two sides disagree — a
   * server that drops the parameter carrying the marker, a name it normalises, a mapping changed on one
   * side only — every lost response silently became a duplicate external collection plus an untracked
   * original. Verifying once per create turns that from silent and unbounded into loud and bounded.
   *
   * The verdict is written to the ledger, not just held in memory: publishing and reconciling happen in
   * different processes, so an in-memory latch would protect neither.
   */
  private async createAndProve(db: Db, intentId: string, itemId: string, token: string): Promise<{ handle: string | null; recovery: RecoveryProof }> {
    let handle: string | null = null;
    try {
      handle = await this.auth.withPublishableIdentity(itemId, this.requires, (identity) => this.target.create(identity, token));
    } catch { return { handle: null, recovery: 'unknown' }; }

    let found: string | null;
    try { found = await this.target.findByToken(token); }
    catch { return { handle, recovery: 'unknown' }; } // a failed lookup proves nothing either way

    const recovery: RecoveryProof = found === handle ? 'verified' : found === null ? 'unrecoverable' : 'contradictory';
    if (recovery !== 'verified') this.recoveryBroken = true;
    // Recording the proof must never lose the create itself: a handle we hold is a tracked artifact, and
    // failing here would throw that away.
    try { await recordRecoveryProof(db, intentId, recovery); } catch { /* surfaced by the result */ }
    return { handle, recovery };
  }

  /** Recover every actionable intent for this target by TOKEN: adopt / (re)create / fail. Idempotent. */
  async reconcile(): Promise<ReconcileResult> {
    // Durable evidence first: a create in some earlier process may already have proved that this target
    // cannot be recovered by token, and this pass must not re-learn that lesson by duplicating.
    // A target with no proof at all has never been observed either way — the pre-Phase-261 assumption,
    // kept so a fresh install still works — and one whose latest proof is 'verified' is trusted again.
    const proof = await latestRecoveryProof(this.pool, this.target.name);
    this.recoveryBroken = proof !== null && proof !== 'verified';
    const intents = await listActionableIntents(this.pool, this.target.name);
    const r: ReconcileResult = { adopted: 0, created: 0, failed: 0, stuck: 0 };
    for (const row of intents) { r[await this.reconcileOne(row)]++; }
    return r;
  }

  private async reconcileOne(row: PublishLedgerRow): Promise<keyof ReconcileResult> {
    const token = row.correlationToken;
    if (token === null || !isUsableToken(token)) return 'stuck'; // no usable recovery key -> never act
    if (row.target !== this.target.name) return 'stuck';         // never act on another target's intent
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockIntent(client, row.id); // serialize reconcilers on this intent (no double-create)
      const cur = (await client.query('SELECT status, attempt_count, target, correlation_token FROM publish_ledger WHERE id = $1', [row.id])).rows[0];
      if (!cur || !ACTIONABLE.has(cur.status)) { await client.query('COMMIT'); return 'stuck'; }
      // Re-read under the lock: the row we act on must still be the row we listed, on THIS target. A
      // mismatch is contradictory state, not a reason to guess.
      if (cur.target !== this.target.name || cur.correlation_token !== token) { await client.query('COMMIT'); return 'stuck'; }

      // (1) durable-token recovery: if the artifact already exists, ADOPT its handle -> published.
      //     A lookup ERROR is NOT "not found": we cannot know whether the collection exists, so we must
      //     NOT (re)create (that could duplicate the original). Leave the intent stuck and retry later.
      let existing: string | null;
      try { existing = await this.target.findByToken(token); }
      catch { await client.query('COMMIT'); return 'stuck'; } // lookup failed -> unknown -> never create
      if (existing !== null) {
        // settle can refuse (the row left the actionable states under us) — do not report an adoption
        // that did not happen.
        const settled = await settleIntent(client, row.id, existing);
        await client.query('COMMIT');
        return settled ? 'adopted' : 'stuck';
      }

      // (2) The lookup found nothing. That is proof of ABSENCE only while token recovery is known to
      //     work; once a create has been observed unrecoverable, "not found" means nothing and creating
      //     would duplicate an artifact we can no longer see. Fail closed.
      if (this.recoveryBroken) { await client.query('COMMIT'); return 'stuck'; }

      // (3) Safe to (re)create within the retry budget, else fail (bounded, surfaced, never looping).
      if (Number(cur.attempt_count) >= MAX_ATTEMPTS) { await markFailed(client, row.id); await client.query('COMMIT'); return 'failed'; }
      if (!(await markInFlight(client, row.id))) { await client.query('COMMIT'); return 'stuck'; } // state moved under us
      const { handle } = await this.createAndProve(client, row.id, row.itemId, token);
      if (handle !== null) {
        const settled = await settleIntent(client, row.id, handle);
        await client.query('COMMIT');
        return settled ? 'created' : 'stuck';
      }
      await markAmbiguous(client, row.id);
      await client.query('COMMIT');
      return 'stuck';
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      return 'stuck';
    } finally {
      client.release();
    }
  }
}

/** Bounded, control-character-free, non-empty: a token is embedded in an external artifact and matched
 *  back out of it, so an unbounded or unprintable one is refused before it is ever persisted or sent. */
const UNPRINTABLE = /[\u0000-\u001f\u007f]/;

function isUsableToken(token: string): boolean {
  return typeof token === 'string'
    && token.length > 0 && token.length <= TOKEN_MAX
    && token.trim().length === token.length
    && !UNPRINTABLE.test(token);
}

function assertUsableToken(token: string): string {
  if (!isUsableToken(token)) throw new Error(`outbox: correlation token must be 1-${TOKEN_MAX} printable, untrimmable characters`);
  return token;
}
