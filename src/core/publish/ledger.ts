import type { Pool } from 'pg';
import type { PublishableField } from '../adapters/publisher.js';

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

export type PublishLedgerStatus = 'published' | 'revoke_pending' | 'revoked';

export interface PublishLedgerRow {
  id: string; // BIGINT as string
  itemId: string;
  target: string;
  externalHandle: string;
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

/** Rows awaiting revocation (identity-free): id + opaque handle + target + attempt count. */
export async function listRevokePending(pool: Pool): Promise<PublishLedgerRow[]> {
  const { rows } = await pool.query(
    `SELECT id, item_id, target, external_handle, disclosed_fields, status, attempt_count
       FROM publish_ledger WHERE status = 'revoke_pending' ORDER BY id ASC`,
  );
  return rows.map(toRow);
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
  id: string; item_id: string; target: string; external_handle: string;
  disclosed_fields: string[]; status: string; attempt_count: number;
}): PublishLedgerRow {
  return {
    id: String(r.id),
    itemId: r.item_id,
    target: r.target,
    externalHandle: r.external_handle,
    disclosedFields: r.disclosed_fields as PublishableField[],
    status: r.status as PublishLedgerStatus,
    attemptCount: Number(r.attempt_count),
  };
}
