import type { PoolClient } from 'pg';
import type { CatalogEvent } from './events.js';

export interface PersistedEvent extends CatalogEvent {
  seq: number;
}

/**
 * The reducer: a pure fold from an event onto the OPERATIONAL projection.
 *
 * It writes only state that is fully derivable from events. It NEVER writes
 * content identity (title/year/external_ids/metadata, or provider ref values) —
 * which is exactly why replaying the log rebuilds operational state and leaves
 * identity NULL until a later phase re-hydrates it.
 *
 * Every statement here runs inside the caller's locked transaction.
 */
export async function reduce(client: PoolClient, e: PersistedEvent): Promise<void> {
  switch (e.type) {
    case 'ItemAdded': {
      await client.query(
        `INSERT INTO items (id, present, forgotten, last_seq, updated_at)
         VALUES ($1, true, false, $2, now())
         ON CONFLICT (id) DO UPDATE
           SET present = true, forgotten = false,
               last_seq = EXCLUDED.last_seq, updated_at = now()`,
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
        `UPDATE items SET last_seq = $2, updated_at = now() WHERE id = $1`,
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
      const weight = Number((e.payload as { weight?: unknown }).weight ?? 0) || 0;
      await client.query(
        `UPDATE items
           SET behavioral_score = behavioral_score + $2,
               last_seq = GREATEST(last_seq, $3), updated_at = now()
         WHERE id = $1`,
        [e.itemId, weight, e.seq],
      );
      return;
    }

    default:
      throw new Error(`reduce: unknown event type "${e.type}"`);
  }
}
