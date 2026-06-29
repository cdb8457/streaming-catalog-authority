import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../db/pool.js';
import { assertNoLeak } from '../redaction/noleak.js';
import { reduce, type PersistedEvent } from './reducer.js';
import * as events from './events.js';
import type { CatalogEvent } from './events.js';

/** Identity supplied to a command. Written to the projection, never to events. */
export interface ItemIdentity {
  title?: string | null;
  year?: number | null;
  externalIds?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  providerRefs?: ReadonlyArray<{ type: string; value: string }>;
}

/**
 * CatalogAuthority is the SOLE writer of items / provider_refs.
 *
 * Every mutation runs through one advisory-locked, single-transaction path:
 *
 *   withItemTxn(itemId):
 *     BEGIN
 *       pg_advisory_xact_lock(hashtextextended(itemId, 0))
 *       assertNoLeak(event.payload)   -- gate runs BEFORE persistence
 *       INSERT INTO events ...        -- append-only; seq auto-assigned
 *       reduce(event)                 -- operational projection only
 *     COMMIT                          -- event + projection atomic
 *
 * `apply(event)` is the only event-sourced mutator. Command handlers (addItem,
 * forget, recordSignal) author opaque events and route through the same path;
 * addItem additionally writes identity into the projection within the same
 * transaction.
 */
export class CatalogAuthority {
  private readonly pool: Pool;

  constructor(pool: Pool = getPool()) {
    this.pool = pool;
  }

  /** The single event-sourced mutator: opaque event in, append + project, atomic. */
  async apply(event: CatalogEvent): Promise<number> {
    return this.withItemTxn(event.itemId, (client) => this.applyInTxn(client, event));
  }

  // --- command handlers -----------------------------------------------------

  async addItem(itemId: string, identity: ItemIdentity = {}): Promise<number> {
    return this.withItemTxn(itemId, async (client) => {
      const seq = await this.applyInTxn(client, events.itemAdded(itemId));

      for (const ref of identity.providerRefs ?? []) {
        await this.applyInTxn(client, events.providerRefAttached(itemId, ref.type));
      }

      // identity side-write: SAME transaction, NEVER placed in an event
      await client.query(
        `UPDATE items
           SET title = $2, year = $3,
               external_ids = $4::jsonb, metadata = $5::jsonb
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

      return seq;
    });
  }

  async forget(itemId: string): Promise<number> {
    return this.apply(events.itemForgotten(itemId));
  }

  async recordSignal(itemId: string, weight: number, ttlMs: number): Promise<number> {
    return this.apply(events.behavioralSignal(itemId, weight, ttlMs));
  }

  // --- maintenance ----------------------------------------------------------

  /**
   * Deterministically rebuilds the projection from the event log. Clears the
   * projection (events untouched) and re-folds by seq. Restores OPERATIONAL
   * state only — identity columns remain NULL.
   */
  async rebuildProjection(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['__rebuild__']);
      await client.query('DELETE FROM items'); // cascades to provider_refs
      const { rows } = await client.query(
        `SELECT seq, item_id, kind, type, payload, expires_at
           FROM events ORDER BY seq ASC`,
      );
      for (const r of rows) {
        await reduce(client, {
          seq: Number(r.seq),
          itemId: r.item_id,
          kind: r.kind,
          type: r.type,
          payload: r.payload,
          expiresAt: r.expires_at,
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Prunes expired behavioral events. The append-only trigger permits DELETE
   * only for behavioral events whose TTL has passed; structural events can
   * never be removed. Returns the number pruned.
   */
  async pruneExpiredBehavioral(): Promise<number> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `DELETE FROM events
          WHERE kind = 'behavioral' AND expires_at IS NOT NULL AND expires_at <= now()`,
      );
      return res.rowCount ?? 0;
    } finally {
      client.release();
    }
  }

  // --- internals ------------------------------------------------------------

  private async applyInTxn(client: PoolClient, event: CatalogEvent): Promise<number> {
    assertNoLeak(event.payload); // gate BEFORE persistence
    const res = await client.query(
      `INSERT INTO events (item_id, kind, type, payload, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING seq`,
      [event.itemId, event.kind, event.type, JSON.stringify(event.payload), event.expiresAt],
    );
    const seq = Number(res.rows[0].seq);
    await reduce(client, { ...event, seq } as PersistedEvent);
    return seq;
  }

  private async withItemTxn<T>(itemId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
}
