import type { Pool, PoolClient } from 'pg';
import type { PublishableField } from '../adapters/publisher.js';

/** Either a pool or a single pooled client (the outbox reconciler holds one client for a per-intent lock). */
export type Db = Pool | PoolClient;

/**
 * Phase 9 — the IDENTITY-FREE publish ledger (persistent audit + revocation driver).
 *
 * A ledger row records that an opaque item was published to a target, at an opaque external handle,
 * disclosing a set of field NAMES — and NOTHING else. It never carries title, ref values,
 * externalIds, metadata, or ciphertext (the DB CHECK also rejects any non-field-name in
 * `disclosedFields`). Rows are the tombstones that survive `forget` so revocation can be driven.
 *
 * All mutation goes through the owner-defined `cat_publish_*` SECURITY DEFINER functions; the app
 * role has SELECT + EXECUTE only (never a raw INSERT/UPDATE on the table).
 */

export type PublishLedgerStatus =
  | 'planned' | 'in_flight' | 'ambiguous'   // Phase 12 outbox intent lifecycle
  | 'published' | 'revoke_pending' | 'revoked' | 'failed';

export interface PublishLedgerRow {
  id: string; // BIGINT as string
  itemId: string;
  target: string;
  externalHandle: string | null;   // NULL until a create is confirmed (Phase 12)
  correlationToken: string | null; // opaque recovery key (Phase 12)
  disclosedFields: PublishableField[];
  status: PublishLedgerStatus;
  attemptCount: number;
}

/** Record a LIVE publish. Returns the new ledger row id. Never call for a dry-run. */
export async function recordPublish(
  pool: Pool,
  args: { itemId: string; target: string; externalHandle: string; disclosedFields: readonly PublishableField[] },
): Promise<string> {
  const { rows } = await pool.query(
    'SELECT cat_publish_record($1, $2, $3, $4) AS id',
    [args.itemId, args.target, args.externalHandle, [...args.disclosedFields]],
  );
  return String(rows[0].id);
}

/** Reconciliation: queue every published row of a now-forgotten item for revocation. Returns count. */
export async function reconcileForgotten(pool: Pool): Promise<number> {
  const { rows } = await pool.query('SELECT cat_publish_reconcile_forgotten() AS n');
  return Number(rows[0].n);
}

const ROW_COLS = 'id, item_id, target, external_handle, correlation_token, disclosed_fields, status, attempt_count';

/** Rows awaiting revocation (identity-free): id + opaque handle + target + attempt count. */
export async function listRevokePending(pool: Pool): Promise<PublishLedgerRow[]> {
  const { rows } = await pool.query(`SELECT ${ROW_COLS} FROM publish_ledger WHERE status = 'revoke_pending' ORDER BY id ASC`);
  return rows.map(toRow);
}

// --- Phase 12 publish-intent outbox accessors (identity-free; token is opaque) ---

/** Write a durable 'planned' intent BEFORE any external side effect. Returns the intent id. */
export async function planPublish(db: Db, args: { itemId: string; target: string; token: string; disclosedFields: readonly PublishableField[] }): Promise<string> {
  const { rows } = await db.query('SELECT cat_publish_plan($1, $2, $3, $4) AS id', [args.itemId, args.target, args.token, [...args.disclosedFields]]);
  return String(rows[0].id);
}

/** Take the xact-scoped per-intent advisory lock (call inside a transaction on the same client). */
export async function lockIntent(db: Db, id: string): Promise<void> { await db.query('SELECT cat_publish_lock_intent($1)', [id]); }
export async function markInFlight(db: Db, id: string): Promise<boolean> { return (await db.query('SELECT cat_publish_mark_in_flight($1) AS ok', [id])).rows[0].ok === true; }
export async function markAmbiguous(db: Db, id: string): Promise<void> { await db.query('SELECT cat_publish_mark_ambiguous($1)', [id]); }
export async function settleIntent(db: Db, id: string, handle: string): Promise<boolean> { return (await db.query('SELECT cat_publish_settle($1, $2) AS ok', [id, handle])).rows[0].ok === true; }
export async function markFailed(db: Db, id: string): Promise<void> { await db.query('SELECT cat_publish_mark_failed($1)', [id]); }

/** Actionable outbox intents for a target (planned/in_flight/ambiguous), oldest first. */
export async function listActionableIntents(db: Db, target: string): Promise<PublishLedgerRow[]> {
  const { rows } = await db.query(`SELECT ${ROW_COLS} FROM publish_ledger WHERE target = $1 AND status IN ('planned','in_flight','ambiguous') ORDER BY id ASC`, [target]);
  return rows.map(toRow);
}

/** Count of stuck intents (in_flight/ambiguous) — surfaced by ops:doctor so they are never hidden. */
export async function countStuckIntents(pool: Pool): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) AS c FROM publish_ledger WHERE status IN ('in_flight','ambiguous')`);
  return Number(rows[0].c);
}

/** Count of unrevoked external copies (revoke_pending) — surfaced by ops so it is never hidden. */
export async function countRevokePending(pool: Pool): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) AS c FROM publish_ledger WHERE status = 'revoke_pending'`);
  return Number(rows[0].c);
}

/** Mark a queued row revoked (revoke_pending -> revoked). Returns whether it transitioned. */
export async function markRevoked(pool: Pool, id: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT cat_publish_mark_revoked($1) AS ok', [id]);
  return rows[0].ok === true;
}

/** Record a failed revoke attempt (keeps the row revoke_pending + retryable). */
export async function markAttempt(pool: Pool, id: string): Promise<void> {
  await pool.query('SELECT cat_publish_mark_attempt($1)', [id]);
}

function toRow(r: {
  id: string; item_id: string; target: string; external_handle: string | null; correlation_token: string | null;
  disclosed_fields: string[]; status: string; attempt_count: number;
}): PublishLedgerRow {
  return {
    id: String(r.id),
    itemId: r.item_id,
    target: r.target,
    externalHandle: r.external_handle,
    correlationToken: r.correlation_token,
    disclosedFields: r.disclosed_fields as PublishableField[],
    status: r.status as PublishLedgerStatus,
    attemptCount: Number(r.attempt_count),
  };
}
