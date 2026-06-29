import type { PoolClient } from 'pg';
import type { CatalogEvent } from './events.js';

export interface PersistedEvent extends CatalogEvent {
  /** BIGINT carried as string — never coerced to an unsafe JS number. */
  seq: string;
}

/**
 * Pure fold from an event onto the OPERATIONAL projection. Writes only state
 * derivable from events; NEVER writes content identity (title/year/external_ids/
 * metadata, or provider ref values). Runs inside the caller's locked txn.
 *
 * `cutoff` makes the behavioral fold deterministic: a behavioral signal counts
 * only while expires_at > cutoff. Live applies pass `now`; rebuild/prune pass a
 * single fixed cutoff so the result is reproducible regardless of wall clock.
 */
export async function reduce(client: PoolClient, e: PersistedEvent, cutoff: Date): Promise<void> {
  switch (e.type) {
    case 'ItemAdded': {
      // Authoring is gated by the command (never emitted for a forgotten item),
      // so this never resurrects identity; forgotten is left untouched here.
      await client.query(
        `INSERT INTO items (id, present, forgotten, last_seq, updated_at)
         VALUES ($1, true, false, $2, now())
         ON CONFLICT (id) DO UPDATE
           SET present = true, last_seq = EXCLUDED.last_seq, updated_at = now()`,
        [e.itemId, e.seq],
      );
      return;
    }

    case 'ItemRestored': {
      await client.query(
        `UPDATE items
           SET present = true, forgotten = false, last_seq = $2, updated_at = now()
         WHERE id = $1`,
        [e.itemId, e.seq],
      );
      return;
    }

    case 'ProviderRefAttached': {
      const refType = String((e.payload as { op?: unknown }).op ?? '');
      await client.query(
        `INSERT INTO provider_refs (item_id, ref_type, present)
         VALUES ($1, $2, true)
         ON CONFLICT (item_id, ref_type) DO UPDATE SET present = true`,
        [e.itemId, refType],
      );
      await client.query(
        `UPDATE items SET last_seq = GREATEST(last_seq, $2), updated_at = now() WHERE id = $1`,
        [e.itemId, e.seq],
      );
      return;
    }

    case 'ItemForgotten': {
      await client.query(
        `UPDATE items
           SET forgotten = true, present = false,
               title = NULL, year = NULL, external_ids = NULL, metadata = NULL,
               last_seq = $2, updated_at = now()
         WHERE id = $1`,
        [e.itemId, e.seq],
      );
      await client.query(
        `UPDATE provider_refs SET present = false, ref_value = NULL WHERE item_id = $1`,
        [e.itemId],
      );
      return;
    }

    case 'BehavioralSignal': {
      const expired = e.expiresAt !== null && e.expiresAt.getTime() <= cutoff.getTime();
      if (expired) {
        // keep last_seq monotonic but do not count an expired signal
        await client.query(
          `UPDATE items SET last_seq = GREATEST(last_seq, $2), updated_at = now() WHERE id = $1`,
          [e.itemId, e.seq],
        );
      } else {
        const weight = Number((e.payload as { weight?: unknown }).weight ?? 0) || 0;
        await client.query(
          `UPDATE items
             SET behavioral_score = behavioral_score + $2,
                 last_seq = GREATEST(last_seq, $3), updated_at = now()
           WHERE id = $1`,
          [e.itemId, weight, e.seq],
        );
      }
      return;
    }

    default:
      throw new Error(`reduce: unknown event type "${e.type}"`);
  }
}
