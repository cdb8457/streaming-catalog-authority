import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getPool } from '../../db/pool.js';
import { isOpaqueItemId } from './events.js';
import {
  encrypt, decrypt, encryptUtf8, decryptUtf8, zeroize, SCHEMA_VERSION, type Aad,
} from '../crypto/envelope.js';
import { InMemoryCustodian, type KeyCustodian } from '../crypto/custodian.js';
import { SecretStore } from '../secrets/secret-store.js';
import { createRedactingLogger, type LogSink, type RedactingLogger } from '../redaction/logger.js';

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
  /** Runtime-only registry of in-flight DEKs and decrypted identity, for log redaction. */
  readonly secrets: SecretStore;

  constructor(pool: Pool = getPool(), custodian: KeyCustodian = new InMemoryCustodian(), secrets: SecretStore = new SecretStore()) {
    this.pool = pool;
    this.custodian = custodian;
    this.secrets = secrets;
  }

  /** A logger that redacts any in-flight DEK / decrypted identity this authority is handling. */
  createLogger(sink?: LogSink): RedactingLogger {
    return createRedactingLogger(this.secrets, sink);
  }

  /** Initial identity creation (new lineage). Idempotent if already present. */
  async addItem(itemId: string, identity: ItemIdentity = {}): Promise<void> {
    this.assertId(itemId);
    await this.provisionAndWrite(itemId, identity, (opId, keyId, epoch, identityCt, refs) =>
      this.pool.query('SELECT cat_add_item_ct($1,$2,$3,$4,$5,$6::jsonb) AS committed', [itemId, opId, keyId, epoch, identityCt, refs])
        .then((r) => r.rows[0].committed === true),
    );
  }

  /** Hydrate an upgraded Phase 1 item (present, no lineage) with encrypted identity. */
  async hydrateLegacy(itemId: string, identity: ItemIdentity = {}): Promise<void> {
    this.assertId(itemId);
    await this.provisionAndWrite(itemId, identity, (opId, keyId, epoch, identityCt, refs) =>
      this.pool.query('SELECT cat_hydrate_legacy_ct($1,$2,$3,$4,$5,$6::jsonb)', [itemId, opId, keyId, epoch, identityCt, refs])
        .then(() => true),
    );
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

  /**
   * Shared provision -> encrypt -> DB write -> commit path with the approved failure matrix:
   * a lost acknowledgement never destroys a committed key; the provisional key is destroyed
   * only when non-commit is positively confirmed. `dbWrite` returns whether the row committed.
   */
  private async provisionAndWrite(
    itemId: string,
    identity: ItemIdentity,
    dbWrite: (opId: string, keyId: string, epoch: number, identityCt: Buffer, refs: string) => Promise<boolean>,
  ): Promise<void> {
    const opId = randomUUID();
    const epoch = 0;
    const { keyId, dek } = await this.custodian.provision(opId, itemId, epoch);
    let committed: boolean;
    try {
      const identityCt = this.encryptIdentity(dek, itemId, epoch, identity);
      const refs = JSON.stringify(this.encryptRefs(dek, itemId, epoch, identity));
      committed = await dbWrite(opId, keyId, epoch, identityCt, refs);
    } catch (dbErr) {
      // The DB call failed (a RAISE such as a forgotten tombstone, or an ambiguous timeout).
      // Destroy the provisional key ONLY if we can positively confirm it did not commit.
      let didCommit: boolean;
      try {
        didCommit = await this.committedByOp(itemId, opId);
      } catch {
        throw dbErr; // cannot confirm -> leave the key; the reconciler (Stage 2b) resolves it
      }
      if (didCommit) {
        await this.tryPromote(opId); // committed despite the error -> promote, never destroy
        return;
      }
      await this.safeDestroy(keyId);
      throw dbErr;
    } finally {
      zeroize(dek);
    }
    if (committed) {
      // A lost ack here leaves the custodian provisional while the DB is committed/active.
      // Do NOT destroy — the reconciler retries the idempotent promotion.
      try { await this.custodian.commitProvision(opId); } catch { /* reconciler will promote */ }
    } else {
      await this.safeDestroy(keyId); // loser of the create race / already present
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
      zeroize(dek); // DEK is a Buffer, zeroized; it is never stringified (§7.2)
    }
  }

  /**
   * Scoped, redaction-protected access to decrypted identity. Every identity string is
   * registered with the SecretStore for the lifetime of `fn` ONLY (deleted afterwards — no
   * long-lived cache), so logging via `createLogger()` inside `fn` is redacted. The plaintext
   * is not returned to the caller; `fn`'s own return value is. Prefer this over `readIdentity`
   * when the plaintext will be logged or passed around.
   */
  async withIdentity<T>(itemId: string, fn: (identity: ItemIdentity | null) => Promise<T> | T): Promise<T> {
    const identity = await this.readIdentity(itemId);
    const names: string[] = [];
    if (identity) {
      for (const value of collectIdentityStrings(identity)) {
        // register the raw value AND its JSON-escaped form, so logging the value either
        // directly or via JSON.stringify is redacted by the literal scan.
        for (const variant of [value, JSON.stringify(value).slice(1, -1)]) {
          if (variant.length === 0) continue;
          const name = `id:${randomUUID()}`;
          this.secrets.set(name, variant);
          names.push(name);
        }
      }
    }
    try {
      return await fn(identity);
    } finally {
      for (const n of names) this.secrets.delete(n);
    }
  }

  /** Explicit restore after a completed shred: a fresh key lineage. */
  async restore(itemId: string, identity: ItemIdentity = {}): Promise<void> {
    this.assertId(itemId);
    await this.provisionAndWrite(itemId, identity, (opId, keyId, epoch, identityCt, refs) =>
      this.pool.query('SELECT cat_restore_ct($1,$2,$3,$4,$5,$6::jsonb)', [itemId, opId, keyId, epoch, identityCt, refs])
        .then(() => true),
    );
  }

  /** Forget coordinator: DB mark (pending) -> custodian destroy -> attested completion. */
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
      await this.pool.query('SELECT cat_forget_complete($1,$2,$3,$4,$5) AS done',
        [itemId, shred_op_id, receipt.receiptId, receipt.destroyedAt, receipt.attestation]);
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

  /** True iff this operation_id established the current lineage row (positively committed). */
  private async committedByOp(itemId: string, opId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM item_key_control WHERE item_id = $1 AND operation_id = $2',
      [itemId, opId],
    );
    return rows.length > 0;
  }

  private async tryPromote(opId: string): Promise<void> {
    try { await this.custodian.commitProvision(opId); } catch { /* reconciler will retry */ }
  }
}

/**
 * Collects every plaintext string in an identity — title, ref values, and the nested
 * VALUES *and KEYS* of externalIds/metadata (keys can themselves be identifying).
 */
function collectIdentityStrings(identity: ItemIdentity): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { if (v.length > 0) out.push(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) { if (k.length > 0) out.push(k); walk(val); }
    }
  };
  walk(identity.title);
  walk(identity.externalIds);
  walk(identity.metadata);
  for (const ref of identity.providerRefs ?? []) walk(ref.value);
  return out;
}
