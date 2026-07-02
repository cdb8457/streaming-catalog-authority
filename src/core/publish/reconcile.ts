import type { Pool } from 'pg';
import type { RevocationAdapter } from '../adapters/revoke.js';
import { reconcileForgotten, listRevokePending, markRevoked, markAttempt } from './ledger.js';

/**
 * Phase 9 — best-effort unpublish for forgotten items (the erasure-conflict reconciliation).
 *
 * `forget` is NEVER modified — it only flips `items.forgotten` and destroys the DEK. This out-of-band
 * step drives the external cleanup:
 *   1. queue published rows of now-forgotten items as `revoke_pending` (reconcileForgotten);
 *   2. for each queued row, ask the revoker to unpublish the OPAQUE handle (no identity);
 *   3. mark `revoked` on success (or `not_found` = already gone), else bump attempt_count and KEEP
 *      the row `revoke_pending` so an unrevoked external copy stays visible + retryable — never
 *      silently dropped.
 */
export interface RevocationRunResult {
  queued: number;   // rows moved published -> revoke_pending this run
  revoked: number;  // rows successfully revoked this run
  failed: number;   // revoke attempts that failed (rows remain revoke_pending)
  pending: number;  // rows still unrevoked after this run (surfaced, never hidden)
}

export async function runRevocation(pool: Pool, revoker: RevocationAdapter): Promise<RevocationRunResult> {
  const queued = await reconcileForgotten(pool);
  const rows = await listRevokePending(pool);
  let revoked = 0;
  let failed = 0;
  for (const row of rows) {
    // A revoke_pending row is always settled (has a handle); guard defensively for the nullable type.
    if (row.externalHandle === null) { await markAttempt(pool, row.id); failed++; continue; }
    let ok = false;
    try {
      const status = (await revoker.revoke(row.externalHandle)).status;
      ok = status === 'revoked' || status === 'not_found'; // not_found = already gone -> success
    } catch {
      ok = false;
    }
    if (ok && (await markRevoked(pool, row.id))) revoked++;
    else { await markAttempt(pool, row.id); failed++; }
  }
  return { queued, revoked, failed, pending: rows.length - revoked };
}
