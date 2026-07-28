import type { Pool } from 'pg';

// Phase 267/268 — the durable, identity-free record of what this installation was asked to do to a media
// server, and what happened.
//
// WHY IT EXISTS. Once queuing external writes is something a person does from a browser, "what did I already
// queue, against what, and did it land?" becomes a question the product has to answer. The in-memory log
// buffer cannot: it holds 200 entries and dies with the container. The publish ledger cannot either — it
// records INTENTS, one per catalog item, with no notion of the plan a human confirmed. This table is the
// human-scale layer above it: one row per decision, not one row per item.
//
// WHAT A ROW CONTAINS: counts, an outcome, two digests, the name the operator gave the PLAN in this product's
// own form (never the name of anything in Jellyfin), an actor and an action. That is the complete list. No
// item id, no title, no provider reference, no external id, no Jellyfin id, no external handle, no address,
// no key, no path. The schema's own CHECKs enforce the shape of every free-text column, so an unsafe row is
// impossible rather than merely unwritten.
//
// A PREVIEW IS RECORDED TOO, AS `planned` / `preview`. A plan somebody looked at and did not execute is
// exactly as interesting as one they did — it is the evidence that the digest they later confirm was seen
// before it was confirmed, and it costs one row.

export const COLLECTION_HISTORY_MAX_ROWS = 50;

export type CollectionHistoryActor = 'cli' | 'operator-ui';
/** `planned` and `audited` wrote nothing external; the rest are the execution verbs. */
export type CollectionHistoryAction = 'planned' | 'queued' | 'reconciled' | 'revoked' | 'audited' | 'repaired';
export type CollectionHistoryOutcome = 'preview' | 'complete' | 'incomplete' | 'refused';

export interface CollectionHistoryCounts {
  readonly selected: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly revoked: number;
  readonly blocked: number;
  readonly failed: number;
}

export interface CollectionHistoryRecord extends CollectionHistoryCounts {
  readonly actor: CollectionHistoryActor;
  readonly action: CollectionHistoryAction;
  readonly target: 'jellyfin';
  readonly name: string;
  readonly planDigest: string;
  readonly basisDigest: string;
  readonly outcome: CollectionHistoryOutcome;
}

export interface CollectionHistoryEntry extends CollectionHistoryRecord {
  readonly id: string;
  readonly recordedAt: string;
}

export interface CollectionHistoryStore {
  record(entry: CollectionHistoryRecord): Promise<void>;
  list(limit: number): Promise<readonly CollectionHistoryEntry[]>;
}

/**
 * The database-backed store.
 *
 * Two statements, both parameterised. The write is the SECURITY DEFINER function and nothing else; the read
 * is one bounded SELECT with a deterministic order (newest first, id as the tie-break so two decisions in the
 * same millisecond still have one fixed order).
 */
export function createCollectionHistoryStore(pool: Pool): CollectionHistoryStore {
  return {
    record: async (entry) => {
      await pool.query(
        'SELECT cat_collection_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
        [
          entry.actor, entry.action, entry.target, entry.name, entry.planDigest, entry.basisDigest,
          entry.selected, entry.created, entry.updated, entry.unchanged, entry.revoked, entry.blocked,
          entry.failed, entry.outcome,
        ],
      );
    },
    list: async (limit) => {
      const bounded = Math.max(1, Math.min(Math.trunc(limit), COLLECTION_HISTORY_MAX_ROWS));
      const { rows } = await pool.query(
        `SELECT id, recorded_at, actor, action, target, name, plan_digest, basis_digest,
                selected, created, updated, unchanged, revoked, blocked, failed, outcome
           FROM collection_control_history ORDER BY recorded_at DESC, id DESC LIMIT $1`,
        [bounded],
      );
      return rows.map((row) => ({
        id: String(row.id),
        recordedAt: (row.recorded_at as Date).toISOString(),
        actor: row.actor as CollectionHistoryActor,
        action: row.action as CollectionHistoryAction,
        target: row.target as 'jellyfin',
        name: row.name as string,
        planDigest: row.plan_digest as string,
        basisDigest: row.basis_digest as string,
        selected: Number(row.selected),
        created: Number(row.created),
        updated: Number(row.updated),
        unchanged: Number(row.unchanged),
        revoked: Number(row.revoked),
        blocked: Number(row.blocked),
        failed: Number(row.failed),
        outcome: row.outcome as CollectionHistoryOutcome,
      }));
    },
  };
}

/** One line per decision, for a CLI or a support report. Counts, digests and the operator's own label. */
export function renderCollectionHistory(entries: readonly CollectionHistoryEntry[]): string {
  if (entries.length === 0) return '  no collection plan has been previewed or queued on this installation';
  return entries.map((entry) =>
    `  ${entry.recordedAt}  ${entry.actor.padEnd(11)}  ${entry.action.padEnd(10)}  ${entry.target}  ${entry.name}  `
    + `select=${entry.selected} create=${entry.created} update=${entry.updated} same=${entry.unchanged} `
    + `revoke=${entry.revoked} blocked=${entry.blocked} failed=${entry.failed}  ${entry.outcome.toUpperCase()} `
    + `(plan ${entry.planDigest.slice(0, 12)}, basis ${entry.basisDigest.slice(0, 12)})`).join('\n');
}
