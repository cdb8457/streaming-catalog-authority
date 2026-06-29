import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../db/pool.js';
import { validateEventPayload } from '../redaction/noleak.js';
import { reduce, type PersistedEvent } from './reducer.js';
import * as events from './events.js';
import { EVENT_REGISTRY, type CatalogEvent } from './events.js';

/** Identity supplied to a command. Written to the projection, never to events. */
export interface ItemIdentity {
  title?: string | null;
  year?: number | null;
  externalIds?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  providerRefs?: ReadonlyArray<{ type: string; value: string }>;
}

export class ForgottenItemError extends Error {
  constructor(itemId: string) {
    super(`item "${itemId}" is forgotten; use restore() to bring it back`);
    this.name = 'ForgottenItemError';
  }
}

// Maintenance lock (two-int advisory key space — disjoint from per-item keys,
// which use the single-bigint space via hashtextextended).
const MAINT_A = 4242;
const MAINT_B = 1;

/**
 * CatalogAuthority is the SOLE writer of items / provider_refs.
 *
 * Writers take a SHARED maintenance lock plus a per-item exclusive lock, then
 * run one append+project transaction. Rebuild/prune take the EXCLUSIVE
 * maintenance lock, so they cannot interleave with any writer.
 */
export class CatalogAuthority {
  private readonly pool: Pool;

  constructor(pool: Pool = getPool()) {
    this.pool = pool;
  }

  /** The single event-sourced mutator: opaque event in, append + project, atomic. */
  async apply(event: CatalogEvent): Promise<string> {
    this.validateEnvelope(event);
    return this.withItemTxn(event.itemId, (client) => this.applyInTxn(client, event, new Date()));
  }

  // --- command handlers -----------------------------------------------------

  /**
   * Idempotent add. First add for an id creates it; a repeat add while present
   * is a no-op (no duplicate ItemAdded). Adding a forgotten item is rejected —
   * forget is terminal unless explicitly restored.
   */
  async addItem(itemId: string, identity: ItemIdentity = {}): Promise<string> {
    return this.withItemTxn(itemId, async (client) => {
      const { rows } = await client.query(
        `SELECT present, forgotten, last_seq FROM items WHERE id = $1`,
        [itemId],
      );
      const existing = rows[0] as { present: boolean; forgotten: boolean; last_seq: string } | undefined;
      if (existing?.forgotten) throw new ForgottenItemError(itemId);
      if (existing?.present) return String(existing.last_seq); // idempotent no-op

      const seq = await this.applyInTxn(client, events.itemAdded(itemId), new Date());
      await this.writeIdentity(client, itemId, identity);
      return seq;
    });
  }

  /** Explicit, sanctioned reversal of forget. Requires a forgotten item. */
  async restore(itemId: string, identity: ItemIdentity = {}): Promise<string> {
    return this.withItemTxn(itemId, async (client) => {
      const { rows } = await client.query(
        `SELECT present, forgotten FROM items WHERE id = $1`,
        [itemId],
      );
      const existing = rows[0] as { present: boolean; forgotten: boolean } | undefined;
      if (!existing) throw new Error(`item "${itemId}" does not exist`);
      if (!existing.forgotten) throw new Error(`item "${itemId}" is not forgotten`);

      const seq = await this.applyInTxn(client, events.itemRestored(itemId), new Date());
      await this.writeIdentity(client, itemId, identity);
      return seq;
    });
  }

  async forget(itemId: string): Promise<string> {
    return this.apply(events.itemForgotten(itemId));
  }

  async recordSignal(itemId: string, weight: number, ttlMs: number): Promise<string> {
    return this.apply(events.behavioralSignal(itemId, weight, ttlMs));
  }

  // --- maintenance ----------------------------------------------------------

  /**
   * Deterministically rebuilds the projection from the log, folding with an
   * explicit `cutoff`. Restores operational state only — identity stays NULL.
   * Holds the exclusive maintenance lock so no writer can interleave.
   */
  async rebuildProjection(cutoff: Date = new Date()): Promise<void> {
    await this.withMaintenanceTxn(async (client) => {
      await this.refold(client, cutoff);
    });
  }

  /**
   * Prune + rebuild as ONE transaction with a single cutoff, so the projection
   * never disagrees with the log: expired behavioral events are deleted (via the
   * narrow SECURITY DEFINER function) and the projection is refolded against the
   * same cutoff. Returns the number of events pruned.
   */
  async pruneAndRebuild(cutoff: Date = new Date()): Promise<number> {
    return this.withMaintenanceTxn(async (client) => {
      const res = await client.query('SELECT prune_expired_behavioral($1) AS n', [cutoff]);
      const pruned = Number(res.rows[0].n);
      await this.refold(client, cutoff);
      return pruned;
    });
  }

  // --- internals ------------------------------------------------------------

  private validateEnvelope(event: CatalogEvent): void {
    const spec = EVENT_REGISTRY[event.type];
    if (!spec) throw new Error(`apply: unknown event type "${event.type}"`);
    if (event.kind !== spec.kind) {
      throw new Error(`apply: event "${event.type}" must be ${spec.kind}, got ${event.kind}`);
    }
    if (spec.ttl && event.expiresAt === null) {
      throw new Error(`apply: behavioral event "${event.type}" requires expiresAt`);
    }
    if (!spec.ttl && event.expiresAt !== null) {
      throw new Error(`apply: structural event "${event.type}" must not have expiresAt`);
    }
  }

  private async applyInTxn(client: PoolClient, event: CatalogEvent, cutoff: Date): Promise<string> {
    this.validateEnvelope(event);
    validateEventPayload(event.type, event.payload); // gate BEFORE persistence
    const res = await client.query(
      `INSERT INTO events (item_id, kind, type, payload, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING seq`,
      [event.itemId, event.kind, event.type, JSON.stringify(event.payload), event.expiresAt],
    );
    const seq = String(res.rows[0].seq);
    await reduce(client, { ...event, seq }, cutoff);
    return seq;
  }

  /** Identity side-write: SAME transaction as the event, NEVER in an event. */
  private async writeIdentity(client: PoolClient, itemId: string, identity: ItemIdentity): Promise<void> {
    for (const ref of identity.providerRefs ?? []) {
      await this.applyInTxn(client, events.providerRefAttached(itemId, ref.type), new Date());
    }
    await client.query(
      `UPDATE items
         SET title = $2, year = $3, external_ids = $4::jsonb, metadata = $5::jsonb
       WHERE id = $1`,
      [
        itemId,
        identity.title ?? null,
        identity.year ?? null,
        identity.externalIds ? JSON.stringify(identity.externalIds) : null,
        identity.metadata ? JSON.stringify(identity.metadata) : null,
      ],
    );
    for (const ref of identity.providerRefs ?? []) {
      await client.query(
        `UPDATE provider_refs SET ref_value = $3 WHERE item_id = $1 AND ref_type = $2`,
        [itemId, ref.type, ref.value],
      );
    }
  }

  private async refold(client: PoolClient, cutoff: Date): Promise<void> {
    await client.query('DELETE FROM items'); // cascades to provider_refs
    const { rows } = await client.query(
      `SELECT seq, item_id, kind, type, payload, expires_at FROM events ORDER BY seq ASC`,
    );
    for (const r of rows) {
      const event: PersistedEvent = {
        seq: String(r.seq),
        itemId: r.item_id,
        kind: r.kind,
        type: r.type,
        payload: r.payload,
        expiresAt: r.expires_at,
      };
      await reduce(client, event, cutoff);
    }
  }

  private async withItemTxn<T>(itemId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [MAINT_A, MAINT_B]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [itemId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async withMaintenanceTxn<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [MAINT_A, MAINT_B]); // exclusive
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
