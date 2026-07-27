import type { Pool } from 'pg';
import type { CatalogAuthority } from '../catalog/authority.js';
import type { PublishableField } from '../adapters/publisher.js';
import { assertPublishAllowed, type PublishConsent } from './consent.js';
import {
  dropManagedMembers,
  latestManagedRecoveryProof,
  listRevokePendingCollections,
  listSyncableCollections,
  lockManagedCollection,
  markManagedAmbiguous,
  markManagedAttempt,
  markManagedFailed,
  markManagedInFlight,
  markManagedRevokePending,
  markManagedRevoked,
  markManagedSynced,
  readManagedCollectionRecord,
  recordManagedRecoveryProof,
  reconcileForgottenMembers,
  settleManagedCollection,
  type ManagedCollectionRecord,
  type ManagedCollectionSummary,
  type Db,
} from './collection-model.js';

// Phase 270 — turning ONE confirmed plan into ONE external collection holding the intended records, and
// keeping the two in agreement afterwards.
//
// THE ORDERING THIS RESTS ON IS UNCHANGED FROM PHASE 12. The durable intent exists BEFORE any side effect: a
// managed collection row and its membership are written by the queue path, which contacts nothing, and this
// service is the only thing that talks to a media server. A container that dies between the two leaves rows a
// later pass acts on, never a change nobody recorded.
//
// RECOVERY IS BY TOKEN, AND A LOOKUP FAILURE IS NEVER ABSENCE. The durable `[cat:<token>]` marker — not the
// possibly-lost create response — decides whether an artifact exists. Found -> adopt the handle. Provably not
// found -> create, within a bounded budget. Lookup FAILED -> do nothing at all, because "I could not see it"
// is not "it is not there", and creating on that is how one lost response becomes two collections. Phase 261's
// durable proof still governs and is now read across BOTH tables: once any create against this target has been
// observed unfindable by its own token, `findByToken() === null` stops meaning absence and nothing is created.
//
// MEMBERSHIP IS RECONCILED BY SET DIFFERENCE, AND THAT IS WHAT MAKES ERASURE WORK. The intended set is
// RESOLVED each pass from the readable members' provider references, through
// `CatalogAuthority.withPublishableIdentity`, which fails closed on a forgotten or shredded record. A
// forgotten member therefore resolves to nothing, falls out of the intended set, and its library items are
// removed as "present but not intended" — WITHOUT this product ever having stored which library items they
// were. Storing them would have been the easy implementation and it would have survived crypto-shredding.
//
// NO REMOVAL IS EVER COMPUTED FROM PARTIAL KNOWLEDGE. A resolution that threw, and a listing that hit its page
// bound, both mean this pass does not know the full intended or current set. Additions still happen (adding
// something that belongs is safe under any uncertainty); removals are DEFERRED. The alternative — treating an
// incomplete read as "these members are not intended" — would strip an operator's collection because a page
// bound was hit.

/** What a grouped collection create is allowed to see of a record: the references, and nothing else.
 *
 *  NARROWER THAN PHASE 268 ON PURPOSE. A per-item collection was NAMED after its record, so the create needed
 *  `title`. A grouped collection is named after the operator's own label, so the title never has to leave the
 *  crypto-shredding boundary at all. This is a disclosure that was removed, not one that moved. */
export const COLLECTION_DISCLOSED_FIELDS: readonly PublishableField[] = ['providerRefs'];

/** How many times a create is attempted before the collection is marked failed and surfaced. */
export const COLLECTION_MAX_ATTEMPTS = 5;

/** A bounded set of opaque external ids, and whether the read that produced it saw everything. */
export interface BoundedIds {
  readonly ids: readonly string[];
  /** TRUE when a bound was hit. A caller must not read this set as complete. */
  readonly truncated: boolean;
}

/**
 * The external operations a managed collection needs. Opaque handles and opaque external ids only — no
 * catalog identity crosses this interface in either direction except the provider references handed to
 * `resolve`, which arrive inside a `withPublishableIdentity` scope and never leave it.
 */
export interface CollectionTarget {
  readonly name: string;
  /**
   * A new pass is starting: discard anything cached from the last one.
   *
   * WHY THIS EXISTS AT ALL. `resolve` matches provider references against the target's library LOCALLY (the
   * server-side filters are unreliable across Jellyfin versions), which means every call would otherwise walk
   * the whole library again — five hundred members against a hundred-thousand-item library is fifty million
   * rows fetched to answer one question. A target may therefore hold ONE snapshot of the candidate listing per
   * pass. That is also the more correct behaviour: every member of a collection is then resolved against the
   * SAME view of the library, so a scan finishing mid-pass cannot make one member's items intended and
   * another's not.
   *
   * Optional, so a caller-supplied double need not implement it.
   */
  beginPass?(): void;
  /** Match provider references to opaque library item ids. Reports truncation rather than implying completeness. */
  resolve(refs: ReadonlyArray<{ type: string; value: string }>): Promise<BoundedIds>;
  /** Create the collection tagged with `token`, holding these library items. Returns the opaque handle. */
  create(name: string, itemIds: readonly string[], token: string): Promise<string>;
  /** Recovery/idempotency: the handle of the collection tagged with `token`, or null if none. */
  findByToken(token: string): Promise<string | null>;
  /** The library items currently in the collection. Reports truncation. */
  listMembers(handle: string): Promise<BoundedIds>;
  addMembers(handle: string, itemIds: readonly string[]): Promise<void>;
  removeMembers(handle: string, itemIds: readonly string[]): Promise<void>;
  /** Delete the collection. `not_found` (already gone) is success. */
  remove(handle: string): Promise<'deleted' | 'not_found'>;
}

export interface CollectionReconcileResult {
  /** External collections created this pass. */
  readonly created: number;
  /** Existing artifacts found by token and adopted (their handle captured). */
  readonly adopted: number;
  /** Collections whose membership was changed to match the plan. */
  readonly updated: number;
  /** Collections already in agreement with the plan. */
  readonly unchanged: number;
  /** Collections this pass could not act on SAFELY and deliberately left for a later one. */
  readonly deferred: number;
  /** Collections whose members resolved to no library item at all — nothing was created. */
  readonly unresolved: number;
  /** Collections that exhausted the retry budget and were marked failed (surfaced, never looping). */
  readonly failed: number;
  /** Collections that would hold nothing and were queued for external deletion instead. */
  readonly queuedRevoke: number;
  /** Library items added and removed across the pass. Counts only; never the ids. */
  readonly added: number;
  readonly removed: number;
}

export interface CollectionRevocationResult {
  /** Member rows queued for removal because their record became unreadable. */
  readonly forgotten: number;
  /** Collections queued for external deletion this pass. */
  readonly queued: number;
  /** Collections whose external copy is now confirmed gone. */
  readonly revoked: number;
  /** Library items taken back out of collections that survive. */
  readonly removed: number;
  /** Attempts that failed. The rows stay queued and retryable — never marked done. */
  readonly failed: number;
  /** Collections still awaiting external deletion after this pass. Surfaced, never hidden. */
  readonly pending: number;
}

type Verdict = 'created' | 'adopted' | 'updated' | 'unchanged' | 'deferred' | 'unresolved' | 'failed' | 'queuedRevoke';

/** What one pass learned about the intended library items of a collection. */
interface Resolution {
  readonly ids: readonly string[];
  /** TRUE when at least one member could not be resolved for a reason that is not "the record is gone". */
  readonly incomplete: boolean;
  /** Members whose record is no longer disclosable. They contribute nothing, and that IS complete knowledge. */
  readonly unreadable: number;
}

export class CollectionOutboxService {
  /**
   * Set the moment a create through THIS service is observed to be unrecoverable or contradictory. Once
   * recovery is known broken for the target, `findByToken() === null` can no longer be read as absence, so
   * nothing further may be created. In-memory is not enough on its own — the process that creates is not the
   * process that reconciles — so every proof is also durable and re-read at the start of each pass. This field
   * only covers the window inside a single pass.
   */
  private recoveryBroken = false;

  constructor(
    private readonly pool: Pool,
    private readonly auth: CatalogAuthority,
    private readonly consent: PublishConsent,
    private readonly target: CollectionTarget,
    private readonly requires: readonly PublishableField[] = COLLECTION_DISCLOSED_FIELDS,
  ) {}

  isRecoveryBroken(): boolean { return this.recoveryBroken; }

  /**
   * One reconcile pass: adopt what exists, create what provably does not, and make membership match.
   *
   * IDEMPOTENT BY CONSTRUCTION. Running it twice over a settled, synced model does nothing at all; running it
   * after a crash resumes exactly the collections that did not finish; running it while the lookup is failing
   * performs no create and no removal whatsoever.
   */
  async reconcile(): Promise<CollectionReconcileResult> {
    // The consent gate is asserted here as well as at the deployment gate above this service. A service that
    // can reach a media server must refuse on its own terms too: gates that only exist in the caller are
    // gates a new caller forgets.
    assertPublishAllowed(this.consent, false);
    this.target.beginPass?.();
    await this.loadRecoveryEvidence();

    const result = { created: 0, adopted: 0, updated: 0, unchanged: 0, deferred: 0, unresolved: 0, failed: 0, queuedRevoke: 0, added: 0, removed: 0 };
    const rows = await listSyncableCollections(this.pool, this.target.name);
    for (const row of rows) {
      const one = await this.reconcileOne(row, true);
      result[one.verdict] += 1;
      result.added += one.added;
      result.removed += one.removed;
    }
    return result;
  }

  /**
   * One revoke pass: queue what erasure demands, take the forgotten members' items back out, then delete the
   * collections that must go — each by its opaque handle.
   *
   * IT CREATES NOTHING. A revoke pass that could also create would mean an operator running the erasure path
   * could cause an external artifact to appear, which is precisely backwards.
   *
   * A FAILED DELETE LEAVES THE ROW QUEUED AND RETRYABLE. An unrevoked external copy of a forgotten record is
   * the single worst state this product can be in, so it stays visible rather than being marked done.
   */
  async revoke(): Promise<CollectionRevocationResult> {
    assertPublishAllowed(this.consent, false);
    this.target.beginPass?.();
    await this.loadRecoveryEvidence();

    const forgotten = await reconcileForgottenMembers(this.pool);

    // (1) Take forgotten/deselected members' library items out of collections that survive. No creates.
    let removed = 0;
    let failed = 0;
    for (const row of await listSyncableCollections(this.pool, this.target.name)) {
      if (row.removing === 0) continue;
      const one = await this.reconcileOne(row, false);
      removed += one.removed;
      if (one.verdict === 'deferred' || one.verdict === 'failed') failed += 1;
    }

    // (2) Delete the collections that must go.
    const pending = await listRevokePendingCollections(this.pool, this.target.name);
    let revoked = 0;
    for (const row of pending) {
      const ok = await this.revokeOne(row);
      if (ok) revoked += 1; else failed += 1;
    }
    return { forgotten, queued: pending.length, revoked, removed, failed, pending: pending.length - revoked };
  }

  /** Re-read the durable recovery evidence for this target. A pass never assumes what an earlier one learned. */
  private async loadRecoveryEvidence(): Promise<void> {
    const proof = await latestManagedRecoveryProof(this.pool, this.target.name);
    // No proof at all means the target has never been observed either way — the pre-Phase-261 assumption,
    // kept so a fresh install still works. A latest proof of 'verified' means it is trusted again.
    this.recoveryBroken = proof !== null && proof !== 'verified';
  }

  private async reconcileOne(
    summary: ManagedCollectionSummary,
    allowCreate: boolean,
  ): Promise<{ verdict: Verdict; added: number; removed: number }> {
    const nothing = (verdict: Verdict): { verdict: Verdict; added: number; removed: number } =>
      ({ verdict, added: 0, removed: 0 });
    if (summary.target !== this.target.name) return nothing('deferred'); // never act on another target's row

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockManagedCollection(client, summary.id); // serialize reconcilers AND the queue path on this row

      // Re-read under the lock: the row we act on must still be the row we listed. A mismatch is a state that
      // moved under us, not a reason to guess.
      const record = await readManagedCollectionRecord(client, summary.id);
      if (record === null || record.target !== this.target.name) { await client.query('COMMIT'); return nothing('deferred'); }
      if (!isActionable(record.status)) { await client.query('COMMIT'); return nothing('deferred'); }
      if (!isMarkerSafeToken(record.correlationToken)) { await client.query('COMMIT'); return nothing('deferred'); }

      const outcome = await this.actOn(client, record, allowCreate);
      await client.query('COMMIT');
      return outcome;
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* the pass reports deferred either way */ }
      return nothing('deferred');
    } finally {
      client.release();
    }
  }

  /** The body of one collection's reconcile, inside the transaction and under the per-collection lock. */
  private async actOn(
    db: Db,
    record: ManagedCollectionRecord,
    allowCreate: boolean,
  ): Promise<{ verdict: Verdict; added: number; removed: number }> {
    const intendedRows = record.memberRows.filter((row) => row.state === 'intended');
    const removingRows = record.memberRows.filter((row) => row.state === 'removing');
    const resolution = await this.resolveIntended(intendedRows.map((row) => row.itemId));

    let handle = record.externalHandle;
    let adopted = false;

    if (handle === null) {
      let found: string | null;
      try { found = await this.target.findByToken(record.correlationToken); }
      catch { return { verdict: 'deferred', added: 0, removed: 0 }; } // a failed lookup proves NOTHING

      if (found !== null) {
        if (!(await settleManagedCollection(db, record.id, found))) return { verdict: 'deferred', added: 0, removed: 0 };
        handle = found;
        adopted = true;
      } else {
        // AN EMPTIED COLLECTION THAT WAS NEVER CREATED IS SIMPLY DONE. Nothing exists out there, so there is
        // nothing to delete; queueing a revoke would be queueing work against an artifact that never was.
        if (intendedRows.length === 0) {
          await markManagedRevokePending(db, record.id);
          await markManagedRevoked(db, record.id);
          return { verdict: 'queuedRevoke', added: 0, removed: 0 };
        }
        if (!allowCreate) return { verdict: 'deferred', added: 0, removed: 0 };
        // "Not found" is proof of ABSENCE only while token recovery is known to work. Fail closed.
        if (this.recoveryBroken) return { verdict: 'deferred', added: 0, removed: 0 };
        // A resolution this pass could not complete must not become the membership of a NEW collection: the
        // collection would be created holding a subset, and every later pass would read that as drift.
        if (resolution.incomplete) return { verdict: 'deferred', added: 0, removed: 0 };
        // Nothing in the library matches any member. Creating an empty collection and then deleting it is not
        // an improvement on creating nothing; this is surfaced and left for the operator to fix.
        if (resolution.ids.length === 0) return { verdict: 'unresolved', added: 0, removed: 0 };

        if (record.attemptCount >= COLLECTION_MAX_ATTEMPTS) {
          await markManagedFailed(db, record.id);
          return { verdict: 'failed', added: 0, removed: 0 };
        }
        if (!(await markManagedInFlight(db, record.id))) return { verdict: 'deferred', added: 0, removed: 0 };

        const created = await this.createAndProve(db, record, resolution.ids);
        if (created === null) {
          await markManagedAmbiguous(db, record.id);
          return { verdict: 'deferred', added: 0, removed: 0 };
        }
        if (!(await settleManagedCollection(db, record.id, created))) return { verdict: 'deferred', added: 0, removed: 0 };
        // The create carried exactly the intended set, so the collection is in agreement by construction.
        await markManagedSynced(db, record.id);
        return { verdict: 'created', added: resolution.ids.length, removed: 0 };
      }
    }

    // A settled collection: make what is out there match what is intended.
    const sync = await this.syncMembership(db, record, handle, resolution, removingRows.map((row) => row.itemId));
    // ADOPTION IS THE HEADLINE WHEN IT HAPPENED. A pass that found a lost artifact by its token and then also
    // corrected its membership is reported as an adoption: recovering an artifact this product had lost track
    // of is the more significant fact, and the item counts still say what moved.
    if (adopted && (sync.verdict === 'unchanged' || sync.verdict === 'updated')) return { ...sync, verdict: 'adopted' };
    return sync;
  }

  /**
   * Bring one settled collection's membership into agreement, or say honestly that it could not.
   *
   * THE SET DIFFERENCE IS THE WHOLE ALGORITHM, AND THE GUARD IN FRONT OF IT IS THE WHOLE SAFETY ARGUMENT.
   * `toAdd` is what belongs and is not there; `toRemove` is what is there and does not belong. Removals are
   * computed ONLY from knowledge this pass can vouch for: an incomplete resolution or a truncated listing
   * suppresses them entirely rather than shrinking the intended set by accident.
   */
  private async syncMembership(
    db: Db,
    record: ManagedCollectionRecord,
    handle: string,
    resolution: Resolution,
    removingIds: readonly string[],
  ): Promise<{ verdict: Verdict; added: number; removed: number }> {
    const intendedRows = record.memberRows.filter((row) => row.state === 'intended');

    // AN EMPTIED COLLECTION IS DELETED, NOT LEFT EMPTY. The test is the recorded membership, not the resolved
    // one: a collection whose members all still exist but match no library item has a library problem, and
    // deleting the operator's collection over that would be a destructive answer to a benign situation.
    if (intendedRows.length === 0) {
      await markManagedRevokePending(db, record.id);
      return { verdict: 'queuedRevoke', added: 0, removed: 0 };
    }

    let current: BoundedIds;
    try { current = await this.target.listMembers(handle); }
    catch { return { verdict: 'deferred', added: 0, removed: 0 }; }

    const intendedSet = new Set(resolution.ids);
    const currentSet = new Set(current.ids);
    const toAdd = [...intendedSet].filter((id) => !currentSet.has(id)).sort();
    // Complete knowledge in BOTH directions is required before anything is taken out of an operator's
    // collection. Either side being partial suppresses every removal in this pass.
    const complete = !resolution.incomplete && !current.truncated;
    const toRemove = complete ? [...currentSet].filter((id) => !intendedSet.has(id)).sort() : [];

    if (toAdd.length > 0) {
      try { await this.target.addMembers(handle, toAdd); }
      catch { return { verdict: 'deferred', added: 0, removed: 0 }; }
    }
    if (toRemove.length > 0) {
      try { await this.target.removeMembers(handle, toRemove); }
      // The adds already landed and are durable out there; report them and leave the removals for a later
      // pass rather than claiming a sync that did not happen.
      catch { return { verdict: 'updated', added: toAdd.length, removed: 0 }; }
    }

    if (complete) {
      // Every library item that does not belong is now gone, so the rows that were driving those removals
      // have nothing left to drive. They are dropped only on a pass that could see everything.
      if (removingIds.length > 0) await dropManagedMembers(db, record.id, removingIds);
      await markManagedSynced(db, record.id);
    }
    const changed = toAdd.length > 0 || toRemove.length > 0;
    return { verdict: changed ? 'updated' : complete ? 'unchanged' : 'deferred', added: toAdd.length, removed: toRemove.length };
  }

  /**
   * Resolve the intended members to opaque library item ids.
   *
   * THE THREE OUTCOMES ARE DELIBERATELY DIFFERENT. A record that is no longer disclosable (forgotten,
   * shredded, absent) yields `null` from `withPublishableIdentity` and contributes nothing — and that IS
   * complete knowledge: it is exactly what "this record must not be out there" means, and it is what drives
   * its removal. A record that resolved to no library item contributes nothing too, and that is also complete.
   * A resolution that THREW, or one whose listing hit a page bound, is INCOMPLETE — this pass does not know
   * the intended set and must not act as though a smaller one were the truth.
   */
  private async resolveIntended(itemIds: readonly string[]): Promise<Resolution> {
    const ids = new Set<string>();
    let incomplete = false;
    let unreadable = 0;
    for (const itemId of itemIds) {
      let outcome: BoundedIds | null;
      try {
        outcome = await this.auth.withPublishableIdentity(itemId, this.requires, async (identity) =>
          this.target.resolve(identity.providerRefs ?? []));
      } catch {
        incomplete = true;
        continue;
      }
      if (outcome === null) { unreadable += 1; continue; } // fail-closed disclosure: the record is gone
      if (outcome.truncated) { incomplete = true; continue; }
      for (const id of outcome.ids) ids.add(id);
    }
    return { ids: [...ids].sort(), incomplete, unreadable };
  }

  /**
   * Create the external collection, then PROVE it is findable by its own token.
   *
   * The duplicate-prevention property rests on one assumption: the token written at create time can be read
   * back at recovery time. Verifying once per create turns a silent, unbounded failure (every lost response
   * becoming a duplicate) into a loud, bounded one. The verdict is written durably, because the process that
   * creates is not the process that reconciles.
   *
   * RECORDING THE PROOF MUST NEVER LOSE THE CREATE. A handle we hold is a tracked, revocable artifact;
   * throwing from here would discard it. Inside this transaction a failed statement aborts the transaction, so
   * the settle and COMMIT that follow fail too and the whole pass rolls back and reports `deferred` — never a
   * false success.
   */
  private async createAndProve(db: Db, record: ManagedCollectionRecord, itemIds: readonly string[]): Promise<string | null> {
    let handle: string;
    try { handle = await this.target.create(record.name, itemIds, record.correlationToken); }
    catch { return null; }

    let found: string | null;
    try { found = await this.target.findByToken(record.correlationToken); }
    catch { return handle; } // a failed lookup proves nothing either way; the handle is still ours

    const proof = found === handle ? 'verified' : found === null ? 'unrecoverable' : 'contradictory';
    if (proof !== 'verified') this.recoveryBroken = true;
    try { await recordManagedRecoveryProof(db, record.id, proof); } catch { /* see above */ }
    return handle;
  }

  /** Delete one queued collection's external copy. Returns whether it is now provably gone. */
  private async revokeOne(summary: ManagedCollectionSummary): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockManagedCollection(client, summary.id);
      const record = await readManagedCollectionRecord(client, summary.id);
      if (record === null || record.status !== 'revoke_pending' || record.target !== this.target.name) {
        await client.query('COMMIT');
        return false;
      }

      let handle = record.externalHandle;
      if (handle === null) {
        // An ambiguous create may have produced an artifact whose handle was lost. The token is the only way
        // to find it, and a lookup that fails proves nothing.
        try { handle = await this.target.findByToken(record.correlationToken); }
        catch { await markManagedAttempt(client, record.id); await client.query('COMMIT'); return false; }
        if (handle === null) {
          // "Not found" is proof of absence ONLY while recovery-by-token is known to work. When it is not,
          // marking this revoked would be recording that an external copy is gone on the strength of a lookup
          // this product has already watched fail — which is the one claim it must never make about erasure.
          if (this.recoveryBroken) { await markManagedAttempt(client, record.id); await client.query('COMMIT'); return false; }
          const done = await markManagedRevoked(client, record.id);
          await client.query('COMMIT');
          return done;
        }
      }

      let outcome: 'deleted' | 'not_found';
      try { outcome = await this.target.remove(handle); }
      catch { await markManagedAttempt(client, record.id); await client.query('COMMIT'); return false; }
      // `not_found` means the external copy is already gone, which is the state a revoke is trying to reach.
      const done = (outcome === 'deleted' || outcome === 'not_found') && await markManagedRevoked(client, record.id);
      if (!done) await markManagedAttempt(client, record.id);
      await client.query('COMMIT');
      return done;
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* reported as a failed attempt */ }
      return false;
    } finally {
      client.release();
    }
  }
}

function isActionable(status: string): boolean {
  return status === 'planned' || status === 'in_flight' || status === 'ambiguous' || status === 'published';
}

/**
 * A correlation token is embedded in an external NAME and matched back out of it, so one that could forge or
 * hide inside another marker is refused before it is ever sent. The same closed class the database CHECK
 * enforces — asserted here too, because a value read back from a row is a value some future migration could
 * have widened.
 */
const MARKER_SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

function isMarkerSafeToken(token: string): boolean {
  return typeof token === 'string' && MARKER_SAFE_TOKEN.test(token);
}
