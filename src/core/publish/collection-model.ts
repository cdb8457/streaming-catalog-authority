import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

// Phase 269 — the DURABLE IDENTITY of a managed collection, and who is allowed to see what about it.
//
// WHAT THIS REPLACES. Through Phase 268 the durable unit of external work was a `publish_ledger` row, which is
// per (item, target). An accepted plan of thirty records therefore became thirty external collections, each
// named after one record — which is not what the operator did. They typed ONE name and chose the records that
// go IN it. This module is the missing noun: a managed collection has its own row, its own lifecycle, its own
// recovery token and its own membership, and a plan addresses it by a derived key rather than by accident.
//
// WHY THE KEY IS DERIVED AND NOT RANDOM. `collectionKeyFor(target, name)` is a domain-separated digest of the
// target and the operator's own label. Deriving it is what makes re-planning the same name an UPDATE of the
// same collection instead of a second collection with the same name — the single most important UX property
// this phase is asked for. A random id would make "the collection I made last week" unaddressable from the one
// thing the operator actually remembers.
//
// WHAT A ROW IS ALLOWED TO CONTAIN, AND WHAT NO CALLER OF THIS MODULE CAN LEARN.
//   * The correlation token and the external handle are NOT on the summary type. They are on the internal
//     record the reconciler reads, and nothing else. A handle is what makes an external copy revocable, it is
//     meaningless outside the revoker, and a field that never reaches a response cannot be rendered by a panel
//     that renders whatever it is given. This is the same discipline `createLedgerReader` already applies.
//   * Membership is opaque catalog item ids. NEVER a target-side library item id: storing those would make
//     membership survive crypto-shredding — after a forget the record's identity is gone, but a stored
//     external id would still say exactly which library items came from it. The reconciler RESOLVES ids each
//     pass through `withPublishableIdentity`, which fails closed on a forgotten record, so a forgotten member
//     resolves to nothing and leaves the intended set without this product ever having recorded what it was.
//
// NOTHING HERE WRITES OUTSIDE THE OWNER-DEFINED FUNCTIONS. Every mutation is a `cat_collection_*` SECURITY
// DEFINER call; the runtime role holds SELECT and EXECUTE and never INSERT/UPDATE/DELETE on either table.

// THIS MODULE NAMES NO TARGET, AND `test/deploy.ts` HAS ENFORCED THAT SINCE PHASE 9. `src/core/publish` is
// the target-agnostic publish machinery: every function here takes `target` as a parameter, and the one
// installation-level answer to "which target" lives beside the planner in `src/ops/collection-plan.ts`. A
// concrete provider named here would be a coupling that a later second target has to unpick.

export type ManagedCollectionStatus =
  | 'planned' | 'in_flight' | 'ambiguous'
  | 'published' | 'revoke_pending' | 'revoked' | 'failed';

export type ManagedMemberState = 'intended' | 'removing';

// THE ACTIVE AND CREATE STATUS SETS ARE NOT DECLARED HERE. They exist once, in SQL: the partial unique index
// `managed_collections_active_uk` and the WHERE clause of each `cat_collection_*` writer. A TypeScript copy
// would be a second definition nothing compares against the first, and the failure mode of two definitions of
// "which states are active" is that they diverge without anything noticing.

/** How many managed collections one read considers. A bound, not a guess: a truncated read says so. */
export const MANAGED_COLLECTION_MAX_ROWS = 500;
/** How many members one collection may hold. The same bound the planner puts on a selection. */
export const MANAGED_COLLECTION_MAX_MEMBERS = 500;

/** What any surface outside the reconciler may learn about a managed collection. No token, no handle. */
export interface ManagedCollectionSummary {
  readonly id: string;
  /** The external system this collection lives on. A value, not a literal type: see the note above. */
  readonly target: string;
  readonly collectionKey: string;
  readonly name: string;
  readonly status: ManagedCollectionStatus;
  /** Whether an external handle has been captured. The HANDLE ITSELF never reaches this type. */
  readonly settled: boolean;
  readonly needsSync: boolean;
  readonly attemptCount: number;
  readonly planDigest: string;
  readonly basisDigest: string;
  readonly recoveryProof: string | null;
  readonly members: number;
  readonly removing: number;
  readonly synced: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One member, as much of it as anything outside the reconciler needs. */
export interface ManagedCollectionMember {
  readonly itemId: string;
  readonly state: ManagedMemberState;
  readonly synced: boolean;
}

/** The reconciler's view. It alone carries the recovery token and the external handle. */
export interface ManagedCollectionRecord extends ManagedCollectionSummary {
  readonly correlationToken: string;
  readonly externalHandle: string | null;
  readonly memberRows: readonly ManagedCollectionMember[];
}

export type Db = Pool | PoolClient;

/**
 * The durable identity of a managed collection.
 *
 * Domain-separated so this digest can never collide with a plan digest, a basis digest or an identity digest
 * computed over the same bytes for a different purpose.
 */
export function collectionKeyFor(target: string, name: string): string {
  // NUL separators, written as ESCAPES rather than literal bytes (a literal one survives no diff or editor
  // reliably). NUL is the one byte a target label and a collection name can never contain, so no two distinct
  // pairs serialise to the same input.
  return createHash('sha256')
    .update(`phase-269-collection/key\u0000${target}\u0000${name}`, 'utf8')
    .digest('hex');
}

const SUMMARY_COLS = `c.id, c.target, c.collection_key, c.name, c.status,
  (c.external_handle IS NOT NULL) AS settled, c.needs_sync, c.attempt_count,
  c.plan_digest, c.basis_digest, c.recovery_proof, c.created_at, c.updated_at,
  (SELECT count(*) FROM managed_collection_members m WHERE m.collection_id = c.id AND m.state = 'intended')::int AS members,
  (SELECT count(*) FROM managed_collection_members m WHERE m.collection_id = c.id AND m.state = 'removing')::int AS removing,
  (SELECT count(*) FROM managed_collection_members m WHERE m.collection_id = c.id AND m.state = 'intended' AND m.synced)::int AS synced`;

interface SummaryRow {
  id: string; target: string; collection_key: string; name: string; status: string;
  settled: boolean; needs_sync: boolean; attempt_count: number;
  plan_digest: string; basis_digest: string; recovery_proof: string | null;
  created_at: Date; updated_at: Date; members: number; removing: number; synced: number;
}

function toSummary(row: SummaryRow): ManagedCollectionSummary {
  return {
    id: String(row.id),
    target: String(row.target),
    collectionKey: row.collection_key,
    name: row.name,
    status: row.status as ManagedCollectionStatus,
    settled: row.settled === true,
    needsSync: row.needs_sync === true,
    attemptCount: Number(row.attempt_count),
    planDigest: row.plan_digest,
    basisDigest: row.basis_digest,
    recoveryProof: row.recovery_proof,
    members: Number(row.members),
    removing: Number(row.removing),
    synced: Number(row.synced),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The read side of the model.
 *
 * EVERY METHOD HERE IS A SELECT. The planner is handed this interface and nothing else that can reach the
 * managed-collection tables, so "planning writes nothing" stays a property of the types rather than a promise
 * about the code — the same argument `CatalogReader` and `LedgerReader` already carry.
 */
export interface ManagedCollectionReader {
  /** The ACTIVE collection for this key, or null. Terminal rows are not active and are not returned. */
  findActive(target: string, collectionKey: string): Promise<ManagedCollectionSummary | null>;
  /** Every member of a collection, ordered by item id so two reads produce one document. */
  listMembers(collectionId: string): Promise<readonly ManagedCollectionMember[]>;
  /** Active collections for a target, oldest first, bounded. */
  listActive(target: string, limit: number): Promise<readonly ManagedCollectionSummary[]>;
  /** Every collection for a target including terminal ones, newest first, bounded. */
  listAll(target: string, limit: number): Promise<readonly ManagedCollectionSummary[]>;
}

export function createManagedCollectionReader(db: Db): ManagedCollectionReader {
  const bound = (limit: number): number => Math.max(1, Math.min(Math.trunc(limit), MANAGED_COLLECTION_MAX_ROWS));
  return {
    findActive: async (target, collectionKey) => {
      const { rows } = await db.query(
        `SELECT ${SUMMARY_COLS} FROM managed_collections c
          WHERE c.target = $1 AND c.collection_key = $2
            AND c.status IN ('planned','in_flight','ambiguous','published','revoke_pending')
          ORDER BY c.id DESC LIMIT 1`,
        [target, collectionKey],
      );
      return rows.length === 0 ? null : toSummary(rows[0] as SummaryRow);
    },
    listMembers: async (collectionId) => {
      const { rows } = await db.query(
        `SELECT item_id, state, synced FROM managed_collection_members
          WHERE collection_id = $1 ORDER BY item_id ASC LIMIT $2`,
        [collectionId, MANAGED_COLLECTION_MAX_MEMBERS * 2],
      );
      return rows.map((row) => ({
        itemId: String(row.item_id),
        state: String(row.state) as ManagedMemberState,
        synced: row.synced === true,
      }));
    },
    listActive: async (target, limit) => {
      const { rows } = await db.query(
        `SELECT ${SUMMARY_COLS} FROM managed_collections c
          WHERE c.target = $1 AND c.status IN ('planned','in_flight','ambiguous','published','revoke_pending')
          ORDER BY c.id ASC LIMIT $2`,
        [target, bound(limit)],
      );
      return rows.map((row) => toSummary(row as SummaryRow));
    },
    listAll: async (target, limit) => {
      const { rows } = await db.query(
        `SELECT ${SUMMARY_COLS} FROM managed_collections c WHERE c.target = $1
          ORDER BY c.id DESC LIMIT $2`,
        [target, bound(limit)],
      );
      return rows.map((row) => toSummary(row as SummaryRow));
    },
  };
}

/**
 * The reconciler's read. It is deliberately a separate function from the reader interface above rather than a
 * method on it: the token and the handle are the two values that must not travel to a planning surface, and
 * keeping them off that interface means a planner cannot disclose them even by accident.
 */
export async function readManagedCollectionRecord(db: Db, id: string): Promise<ManagedCollectionRecord | null> {
  const { rows } = await db.query(
    `SELECT ${SUMMARY_COLS}, c.correlation_token, c.external_handle
       FROM managed_collections c WHERE c.id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const row = rows[0] as SummaryRow & { correlation_token: string; external_handle: string | null };
  const members = await createManagedCollectionReader(db).listMembers(String(row.id));
  return {
    ...toSummary(row),
    correlationToken: String(row.correlation_token),
    externalHandle: row.external_handle,
    memberRows: members,
  };
}

/** Insert-or-adopt the active collection for a key, atomically. Returns its id. */
export async function upsertManagedCollection(
  db: Db,
  args: {
    target: string; collectionKey: string; name: string; token: string;
    planDigest: string; basisDigest: string;
  },
): Promise<string> {
  const { rows } = await db.query(
    'SELECT cat_collection_upsert($1, $2, $3, $4, $5, $6) AS id',
    [args.target, args.collectionKey, args.name, args.token, args.planDigest, args.basisDigest],
  );
  return String(rows[0].id);
}

/**
 * Set the intended membership to exactly these ids.
 *
 * BOUNDED BEFORE IT IS SENT. An unbounded array reaching a SECURITY DEFINER function is an unbounded statement,
 * and the planner's own limit is the number this is allowed to be.
 */
export async function setManagedMembers(db: Db, collectionId: string, itemIds: readonly string[]): Promise<number> {
  if (itemIds.length > MANAGED_COLLECTION_MAX_MEMBERS) {
    throw new Error(`managed collection: a membership of ${itemIds.length} exceeds the ${MANAGED_COLLECTION_MAX_MEMBERS} bound`);
  }
  const { rows } = await db.query('SELECT cat_collection_set_members($1, $2) AS n', [collectionId, [...itemIds]]);
  return Number(rows[0].n);
}

export async function lockManagedCollection(db: Db, id: string): Promise<void> {
  await db.query('SELECT cat_collection_lock($1)', [id]);
}

export async function markManagedInFlight(db: Db, id: string): Promise<boolean> {
  return (await db.query('SELECT cat_collection_mark_in_flight($1) AS ok', [id])).rows[0].ok === true;
}

export async function markManagedAmbiguous(db: Db, id: string): Promise<void> {
  await db.query('SELECT cat_collection_mark_ambiguous($1)', [id]);
}

export async function settleManagedCollection(db: Db, id: string, handle: string): Promise<boolean> {
  return (await db.query('SELECT cat_collection_settle($1, $2) AS ok', [id, handle])).rows[0].ok === true;
}

export async function markManagedFailed(db: Db, id: string): Promise<void> {
  await db.query('SELECT cat_collection_mark_failed($1)', [id]);
}

export type ManagedRecoveryProof = 'verified' | 'unrecoverable' | 'contradictory';

export async function recordManagedRecoveryProof(db: Db, id: string, proof: ManagedRecoveryProof): Promise<void> {
  await db.query('SELECT cat_collection_record_recovery($1, $2)', [id, proof]);
}

/**
 * The most recent recovery proof for a target, from the per-item ledger AND the managed collections.
 *
 * Both paths write the same `[cat:<token>]` marker to the same server, so a proof made by either is evidence
 * about the target, and the grouped reconciler must stop trusting "not found" the moment either observes the
 * marker failing to round-trip. Only the latest matters: a target proved working again is trusted again.
 */
export async function latestManagedRecoveryProof(db: Db, target: string): Promise<ManagedRecoveryProof | null> {
  const { rows } = await db.query('SELECT cat_collection_recovery_proof($1) AS proof', [target]);
  const proof = rows[0]?.proof as ManagedRecoveryProof | null | undefined;
  return proof ?? null;
}

export async function markManagedSynced(db: Db, id: string): Promise<void> {
  await db.query('SELECT cat_collection_mark_synced($1)', [id]);
}

export async function dropManagedMembers(db: Db, id: string, itemIds: readonly string[]): Promise<number> {
  if (itemIds.length === 0) return 0;
  const { rows } = await db.query('SELECT cat_collection_drop_members($1, $2) AS n', [id, [...itemIds]]);
  return Number(rows[0].n);
}

export async function markManagedRevokePending(db: Db, id: string): Promise<boolean> {
  return (await db.query('SELECT cat_collection_mark_revoke_pending($1) AS ok', [id])).rows[0].ok === true;
}

export async function markManagedRevoked(db: Db, id: string): Promise<boolean> {
  return (await db.query('SELECT cat_collection_mark_revoked($1) AS ok', [id])).rows[0].ok === true;
}

export async function markManagedAttempt(db: Db, id: string): Promise<void> {
  await db.query('SELECT cat_collection_mark_attempt($1)', [id]);
}

/**
 * Phase 271 repair: move a settled collection back onto the create path after a drift audit proved its
 * external artifact absent. It creates NOTHING — the ordinary reconcile pass, with every gate it already has,
 * is what decides. The correlation token is deliberately kept, so an audit that was wrong ends in an adoption
 * rather than a duplicate.
 */
export async function rearmManagedCollection(db: Db, id: string): Promise<boolean> {
  return (await db.query('SELECT cat_collection_rearm($1) AS ok', [id])).rows[0].ok === true;
}

/** Phase 271 repair: schedule a membership comparison. The mildest repair write there is. */
export async function touchManagedCollection(db: Db, id: string): Promise<boolean> {
  return (await db.query('SELECT cat_collection_touch($1) AS ok', [id])).rows[0].ok === true;
}

/** Forget's grouped driver: queue every unreadable member for removal. Returns the member count queued. */
export async function reconcileForgottenMembers(db: Db): Promise<number> {
  const { rows } = await db.query('SELECT cat_collection_reconcile_forgotten() AS n');
  return Number(rows[0].n);
}

/** Collections a reconcile pass should look at: unsettled ones, and settled ones whose membership may differ. */
export async function listSyncableCollections(db: Db, target: string): Promise<readonly ManagedCollectionSummary[]> {
  const { rows } = await db.query(
    `SELECT ${SUMMARY_COLS} FROM managed_collections c
      WHERE c.target = $1
        AND (c.status IN ('planned','in_flight','ambiguous') OR (c.status = 'published' AND c.needs_sync))
      ORDER BY c.id ASC LIMIT $2`,
    [target, MANAGED_COLLECTION_MAX_ROWS],
  );
  return rows.map((row) => toSummary(row as SummaryRow));
}

/** Collections queued for external deletion, oldest first. */
export async function listRevokePendingCollections(db: Db, target: string): Promise<readonly ManagedCollectionSummary[]> {
  const { rows } = await db.query(
    `SELECT ${SUMMARY_COLS} FROM managed_collections c
      WHERE c.target = $1 AND c.status = 'revoke_pending' ORDER BY c.id ASC LIMIT $2`,
    [target, MANAGED_COLLECTION_MAX_ROWS],
  );
  return rows.map((row) => toSummary(row as SummaryRow));
}

/** Managed-collection counts by status. The complete picture, including the boring states. */
export async function readManagedCounts(db: Db, target: string): Promise<Readonly<Record<string, number>>> {
  const { rows } = await db.query(
    'SELECT status, count(*)::int AS n FROM managed_collections WHERE target = $1 GROUP BY status',
    [target],
  );
  const counts: Record<string, number> = {
    planned: 0, in_flight: 0, ambiguous: 0, published: 0, revoke_pending: 0, revoked: 0, failed: 0,
  };
  for (const row of rows) counts[String(row.status)] = Number(row.n);
  return counts;
}
