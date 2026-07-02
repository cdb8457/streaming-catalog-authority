import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { CatalogAuthority } from '../catalog/authority.js';
import type { PublishableField, PublishableIdentity } from '../adapters/publisher.js';
import { assertPublishAllowed, type PublishConsent } from './consent.js';
import {
  planPublish, lockIntent, markInFlight, markAmbiguous, settleIntent, markFailed,
  listActionableIntents, type PublishLedgerRow,
} from './ledger.js';

/**
 * Phase 12 — durable publish-intent OUTBOX. Makes a remote create orphan-safe:
 *  1. write a durable 'planned' intent (identity-free, opaque `token`) BEFORE any side effect;
 *  2. tag the created artifact with the same `token`;
 *  3. recover by TOKEN — the durable token, NOT the (possibly-lost) response handle, is the source of
 *     truth. reconcile() searches the target for the token: found → adopt the handle (published);
 *     not found → (re)create within a bounded budget, else fail. Result: at every crash point an
 *     intent ends TRACKED (revocable) or provably GONE — never an untracked/unrevocable orphan.
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
export interface OutboxResult { intentId: string; status: OutboxOutcome; handle?: string; }
export interface ReconcileResult { adopted: number; created: number; failed: number; stuck: number; }

const MAX_ATTEMPTS = 5;
const ACTIONABLE = new Set(['planned', 'in_flight', 'ambiguous']);

export class OutboxService {
  constructor(
    private readonly pool: Pool,
    private readonly auth: CatalogAuthority,
    private readonly consent: PublishConsent,
    private readonly target: OutboxTarget,
    private readonly requires: readonly PublishableField[],
    private readonly newToken: () => string = randomUUID,
  ) {}

  /** Consent-gated. Plan a durable intent, then attempt the create once. Recovery is via reconcile(). */
  async publish(itemId: string, opts: { dryRun?: boolean } = {}): Promise<OutboxResult> {
    const dryRun = opts.dryRun ?? true;
    assertPublishAllowed(this.consent, dryRun); // live create refused unless consent=allow
    if (dryRun) return { intentId: '', status: 'skipped' }; // dry-run: no intent, no side effect
    const token = this.newToken();
    const intentId = await planPublish(this.pool, { itemId, target: this.target.name, token, disclosedFields: this.requires });
    return this.attemptCreate(intentId, token, itemId);
  }

  private async attemptCreate(intentId: string, token: string, itemId: string): Promise<OutboxResult> {
    await markInFlight(this.pool, intentId);
    let handle: string | null = null;
    try {
      handle = await this.auth.withPublishableIdentity(itemId, this.requires, (identity) => this.target.create(identity, token));
    } catch { handle = null; }
    if (handle !== null && (await settleIntent(this.pool, intentId, handle))) {
      return { intentId, status: 'published', handle };
    }
    // create failed / response lost / item not disclosable -> ambiguous; reconcile() recovers by token.
    await markAmbiguous(this.pool, intentId);
    return { intentId, status: 'ambiguous' };
  }

  /** Recover every actionable intent for this target by TOKEN: adopt / (re)create / fail. Idempotent. */
  async reconcile(): Promise<ReconcileResult> {
    const intents = await listActionableIntents(this.pool, this.target.name);
    const r: ReconcileResult = { adopted: 0, created: 0, failed: 0, stuck: 0 };
    for (const row of intents) { r[await this.reconcileOne(row)]++; }
    return r;
  }

  private async reconcileOne(row: PublishLedgerRow): Promise<keyof ReconcileResult> {
    const token = row.correlationToken;
    if (token === null) return 'stuck';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockIntent(client, row.id); // serialize reconcilers on this intent (no double-create)
      const cur = (await client.query('SELECT status, attempt_count FROM publish_ledger WHERE id = $1', [row.id])).rows[0];
      if (!cur || !ACTIONABLE.has(cur.status)) { await client.query('COMMIT'); return 'stuck'; }

      // (1) durable-token recovery: if the artifact already exists, ADOPT its handle -> published.
      let existing: string | null = null;
      try { existing = await this.target.findByToken(token); } catch { existing = null; }
      if (existing !== null) { await settleIntent(client, row.id, existing); await client.query('COMMIT'); return 'adopted'; }

      // (2) not created yet: (re)create within the retry budget, else fail (surfaced by doctor).
      if (Number(cur.attempt_count) >= MAX_ATTEMPTS) { await markFailed(client, row.id); await client.query('COMMIT'); return 'failed'; }
      await markInFlight(client, row.id);
      let handle: string | null = null;
      try { handle = await this.auth.withPublishableIdentity(row.itemId, this.requires, (identity) => this.target.create(identity, token)); }
      catch { handle = null; }
      if (handle !== null) { await settleIntent(client, row.id, handle); await client.query('COMMIT'); return 'created'; }
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
