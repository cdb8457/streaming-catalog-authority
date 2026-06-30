import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getPool } from '../../db/pool.js';
import { isOpaqueItemId } from './events.js';
import {
  encrypt, decrypt, encryptUtf8, decryptUtf8, zeroize, SCHEMA_VERSION, type Aad,
} from '../crypto/envelope.js';
import { InMemoryCustodian, type KeyCustodian } from '../crypto/custodian.js';

/** Plaintext identity (client-side only — encrypted before it reaches the DB). */
export interface ItemIdentity {
  title?: string | null;
  year?: number | null;
  externalIds?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  providerRefs?: ReadonlyArray<{ type: string; value: string }>;
}

export type ForgetState = 'shred_pending' | 'shred_complete';

const FIELD_IDENTITY = 'identity';
const refField = (type: string): string => `ref:${type}`;

/**
 * Typed client over the DB-resident authority + key custodian (Phase 2).
 *
 * Identity is encrypted in this process (per-item DEK from the custodian) and
 * only ciphertext is sent to the DB. `forget` is a coordinator: a DB step marks
 * shred_pending and clears ciphertext, the custodian destroys the key lineage,
 * then a DB step records completion. Reads are fail-closed and re-checked at
 * their linearization point. (Reconciler + concurrent-race + old-backup self-heal
 * land in Stage 2b.)
 */
export class CatalogAuthority {
  private readonly pool: Pool;
  private readonly custodian: KeyCustodian;

  constructor(pool: Pool = getPool(), custodian: KeyCustodian = new InMemoryCustodian()) {
    this.pool = pool;
    this.custodian = custodian;
  }

  /** Initial identity creation (new lineage). Idempotent if already present. */
  async addItem(itemId: string, identity: ItemIdentity = {}): Promise<void> {
    this.assertId(itemId);
    const opId = randomUUID();
    const epoch = 0;
    const { keyId, dek } = await this.custodian.provision(opId, itemId, epoch);
    try {
      const identityCt = this.encryptIdentity(dek, itemId, epoch, identity);
      const refs = this.encryptRefs(dek, itemId, epoch, identity);
      const { rows } = await this.pool.query(
        'SELECT cat_add_item_ct($1,$2,$3,$4,$5,$6::jsonb) AS committed',
        [itemId, opId, keyId, epoch, identityCt, JSON.stringify(refs)],
      );
      if (rows[0].committed === true) {
        await this.custodian.commitProvision(opId);
      } else {
        // lost the create race or already present: this provisional key is unused
        await this.custodian.destroy(randomUUID(), keyId);
      }
    } catch (err) {
      // DB rejected (e.g. forgotten tombstone): destroy the orphan provisional key
      await this.safeDestroy(keyId);
      throw err;
    } finally {
      zeroize(dek);
    }
  }

  /** In-lineage identity update: reuses the active key/epoch, fresh nonces. */
  async updateIdentity(itemId: string, identity: ItemIdentity): Promise<void> {
    this.assertId(itemId);
    const ctrl = await this.control(itemId);
    if (!ctrl || ctrl.shred_state !== 'active') throw new Error('no active identity lineage to update');
    const dek = await this.custodian.get(ctrl.key_id, ctrl.cur_epoch);
    try {
      const identityCt = this.encryptIdentity(dek, itemId, ctrl.cur_epoch, identity);
      const refs = this.encryptRefs(dek, itemId, ctrl.cur_epoch, identity);
      await this.pool.query('SELECT cat_update_identity_ct($1,$2,$3::jsonb)', [itemId, identityCt, JSON.stringify(refs)]);
    } finally {
      zeroize(dek);
    }
  }

  /** Fail-closed identity read; re-checks status at the linearization point. */
  async readIdentity(itemId: string): Promise<ItemIdentity | null> {
    this.assertId(itemId);
    const { rows } = await this.pool.query(
      `SELECT i.present, i.forgotten, i.identity_ct, k.key_id, k.cur_epoch, k.shred_state
         FROM items i LEFT JOIN item_key_control k ON k.item_id = i.id WHERE i.id = $1`,
      [itemId],
    );
    const row = rows[0];
    if (!row || !row.present || row.forgotten || !row.identity_ct) return null;
    if (!row.key_id || row.shred_state !== 'active') return null; // fail closed
    let status: string;
    try {
      status = await this.custodian.status(row.key_id);
    } catch {
      return null; // transport failure -> fail closed
    }
    if (status !== 'active') return null;

    let dek: Buffer;
    try {
      dek = await this.custodian.get(row.key_id, row.cur_epoch);
    } catch {
      return null;
    }
    try {
      const identity = this.decryptIdentity(dek, itemId, row.cur_epoch, row.identity_ct as Buffer);
      const refRows = (await this.pool.query(
        `SELECT ref_type, ref_value_ct FROM provider_refs WHERE item_id = $1 AND present AND ref_value_ct IS NOT NULL`,
        [itemId],
      )).rows;
      const providerRefs = refRows.map((r) => ({
        type: r.ref_type as string,
        value: decryptUtf8(dek, r.ref_value_ct as Buffer, this.aad(itemId, row.cur_epoch, refField(r.ref_type))),
      }));

      // recheck-before-return (linearization point): status + DB shred_state still active
      let recheck: string;
      try { recheck = await this.custodian.status(row.key_id); } catch { return null; }
      const stillActive = (await this.control(itemId))?.shred_state === 'active';
      if (recheck !== 'active' || !stillActive) return null;

      return providerRefs.length ? { ...identity, providerRefs } : identity;
    } finally {
      zeroize(dek);
    }
  }

  /** Explicit restore after a completed shred: a fresh key lineage. */
  async restore(itemId: string, identity: ItemIdentity = {}): Promise<void> {
    this.assertId(itemId);
    const opId = randomUUID();
    const epoch = 0;
    const { keyId, dek } = await this.custodian.provision(opId, itemId, epoch);
    try {
      const identityCt = this.encryptIdentity(dek, itemId, epoch, identity);
      const refs = this.encryptRefs(dek, itemId, epoch, identity);
      await this.pool.query('SELECT cat_restore_ct($1,$2,$3,$4,$5,$6::jsonb)', [itemId, opId, keyId, epoch, identityCt, JSON.stringify(refs)]);
      await this.custodian.commitProvision(opId);
    } catch (err) {
      await this.safeDestroy(keyId);
      throw err;
    } finally {
      zeroize(dek);
    }
  }

  /** Forget coordinator: DB mark + key destruction + completion. */
  async forget(itemId: string): Promise<ForgetState> {
    this.assertId(itemId);
    const { rows } = await this.pool.query(
      'SELECT key_id, shred_op_id, needs_destroy FROM cat_forget_begin($1)',
      [itemId],
    );
    const { key_id, shred_op_id, needs_destroy } = rows[0];
    if (!needs_destroy) return 'shred_complete'; // no key to destroy (tombstone only)
    try {
      const receipt = await this.custodian.destroy(shred_op_id, key_id);
      await this.pool.query('SELECT cat_forget_complete($1,$2,$3)', [itemId, shred_op_id, receipt.receiptId]);
      return 'shred_complete';
    } catch {
      return 'shred_pending'; // reconciler (Stage 2b) will finish it
    }
  }

  async recordSignal(itemId: string, weight: number, ttlMs: number): Promise<string> {
    this.assertId(itemId);
    const { rows } = await this.pool.query('SELECT cat_record_signal($1,$2,$3) AS seq', [itemId, weight, ttlMs]);
    return String(rows[0].seq);
  }

  async rebuildProjection(cutoff: Date = new Date()): Promise<void> {
    await this.pool.query('SELECT cat_rebuild($1)', [cutoff]);
  }

  async pruneAndRebuild(cutoff: Date = new Date()): Promise<number> {
    const { rows } = await this.pool.query('SELECT cat_prune_and_rebuild($1) AS n', [cutoff]);
    return Number(rows[0].n);
  }

  // --- helpers --------------------------------------------------------------

  private assertId(itemId: string): void {
    if (!isOpaqueItemId(itemId)) throw new Error('item id must be opaque (uuid)');
  }

  private aad(itemId: string, keyEpoch: number, field: string): Aad {
    return { itemId, keyEpoch, schemaVersion: SCHEMA_VERSION, field };
  }

  private encryptIdentity(dek: Buffer, itemId: string, epoch: number, identity: ItemIdentity): Buffer {
    const blob = JSON.stringify({
      title: identity.title ?? null,
      year: identity.year ?? null,
      externalIds: identity.externalIds ?? null,
      metadata: identity.metadata ?? null,
    });
    return encrypt(dek, Buffer.from(blob, 'utf8'), this.aad(itemId, epoch, FIELD_IDENTITY));
  }

  private decryptIdentity(dek: Buffer, itemId: string, epoch: number, ct: Buffer): ItemIdentity {
    const buf = decrypt(dek, ct, this.aad(itemId, epoch, FIELD_IDENTITY));
    try {
      return JSON.parse(buf.toString('utf8')) as ItemIdentity;
    } finally {
      buf.fill(0);
    }
  }

  private encryptRefs(dek: Buffer, itemId: string, epoch: number, identity: ItemIdentity): Array<{ type: string; ct: string }> {
    return (identity.providerRefs ?? []).map((r) => ({
      type: r.type,
      ct: encryptUtf8(dek, r.value, this.aad(itemId, epoch, refField(r.type))).toString('hex'),
    }));
  }

  private async control(itemId: string): Promise<{ key_id: string; cur_epoch: number; shred_state: string } | null> {
    const { rows } = await this.pool.query(
      'SELECT key_id, cur_epoch, shred_state FROM item_key_control WHERE item_id = $1',
      [itemId],
    );
    return rows[0] ?? null;
  }

  private async safeDestroy(keyId: string): Promise<void> {
    try {
      await this.custodian.destroy(randomUUID(), keyId);
    } catch {
      /* best-effort; reconciler (Stage 2b) sweeps orphans */
    }
  }
}
