import { createHmac, randomBytes, randomUUID } from 'node:crypto';

/**
 * Dev/test completion secret. In production the custodian is EXTERNAL and shares this
 * secret out-of-band with the database ONLY (never with the app), so the app cannot forge a
 * destruction attestation. The in-process custodian uses a well-known dev value that the
 * migration also seeds into the owner-only crypto_config table.
 */
export const DEV_COMPLETION_SECRET = 'dev-completion-secret-v1';

/**
 * Key custodian (design §2). Owns wrapping/rotation state and the DEK lifecycle.
 *
 * Contract + invariants:
 *  - status is a definite value (provisional|active|destroyed|not_found);
 *    transport/service failure is a THROWN error, never a status value.
 *  - destroyed is terminal: a delayed commitProvision can never reactivate it.
 *  - operation_id is bound to its inputs: reuse with different inputs fails;
 *    an identical retry is idempotent.
 *  - destroy is idempotent on BOTH operation_id and key_id, returns the same
 *    receipt, and leaves a durable non-secret tombstone.
 */

export type KeyStatus = 'provisional' | 'active' | 'destroyed' | 'not_found';

export interface ProvisionResult {
  keyId: string;
  /** A fresh copy of the DEK (32 bytes). Caller owns it and should zeroize it. */
  dek: Buffer;
}

export interface DestructionReceipt {
  keyId: string;
  receiptId: string;
  destroyedAt: string; // ISO timestamp (non-secret, durable)
  /**
   * HMAC over `${keyId}:${operationId}` under the completion secret. The DB verifies this
   * before marking shred_complete, so the app cannot fabricate a completion (it does not
   * hold the secret in production).
   */
  attestation: string;
}

export interface StaleProvisioning {
  operationId: string;
  itemId: string;
  keyId: string;
  ageMs: number;
}

export interface KeyCustodian {
  provision(operationId: string, itemId: string, epoch: number): Promise<ProvisionResult>;
  commitProvision(operationId: string): Promise<void>;
  get(keyId: string, epoch: number): Promise<Buffer>;
  destroy(operationId: string, keyId: string): Promise<DestructionReceipt>;
  status(keyId: string): Promise<KeyStatus>;
  listStaleProvisioning(): Promise<StaleProvisioning[]>;
}

export class CustodianTransportError extends Error {
  constructor(op: string) {
    super(`custodian transport failure during ${op}`);
    this.name = 'CustodianTransportError';
  }
}

interface KeyRecord {
  keyId: string;
  itemId: string;
  epoch: number;
  provisionOpId: string;
  state: 'provisional' | 'active' | 'destroyed';
  dek: Buffer | null; // nulled (after zeroize) on destroy; tombstone fields remain
  createdAt: number;
  receipt?: DestructionReceipt;
}

interface OpRecord {
  operationId: string;
  kind: 'provision' | 'destroy';
  keyId: string;
  itemId?: string;
  epoch?: number;
}

/**
 * In-process custodian for dev/tests. Implements the full contract and supports
 * fault injection (to simulate transport failures and partial outages). It does
 * NOT provide the production deletion guarantee — a real adapter + integration
 * suite is required before claiming production shredding (design O4).
 *
 * `clock` is injectable so tests stay deterministic (no ambient Date.now()).
 */
type FaultOp = 'provision' | 'commit' | 'get' | 'destroy' | 'status' | 'list';
type FaultWhen = 'before' | 'after';

export class InMemoryCustodian implements KeyCustodian {
  private readonly keys = new Map<string, KeyRecord>();
  private readonly ops = new Map<string, OpRecord>();
  private readonly receiptIds = new Set<string>();
  private readonly faults = new Map<string, Error>();
  private readonly clock: () => number;
  private readonly completionSecret: string;

  constructor(clock: () => number = () => Date.now(), completionSecret: string = DEV_COMPLETION_SECRET) {
    this.clock = clock;
    this.completionSecret = completionSecret;
  }

  private attest(keyId: string, operationId: string): string {
    return createHmac('sha256', this.completionSecret).update(`${keyId}:${operationId}`).digest('hex');
  }

  /**
   * Test hook: make the named op throw. `when='before'` fails before any
   * mutation; `when='after'` performs the mutation and then throws — simulating
   * a lost acknowledgement, so a retry must observe the idempotent result.
   */
  setFault(op: FaultOp, err: Error | null, when: FaultWhen = 'before'): void {
    const key = `${op}:${when}`;
    if (err) this.faults.set(key, err);
    else this.faults.delete(key);
  }
  private trip(op: FaultOp, when: FaultWhen): void {
    const e = this.faults.get(`${op}:${when}`);
    if (e) throw e;
  }

  private freshId(prefix: string, taken: (id: string) => boolean): string {
    let id: string;
    do {
      id = prefix + randomUUID(); // 128-bit
    } while (taken(id));
    return id;
  }

  async provision(operationId: string, itemId: string, epoch: number): Promise<ProvisionResult> {
    this.trip('provision', 'before');
    const prior = this.ops.get(operationId);
    if (prior) {
      if (prior.kind !== 'provision' || prior.itemId !== itemId || prior.epoch !== epoch) {
        throw new Error('operation_id reused with different inputs');
      }
      const rec = this.keys.get(prior.keyId)!;
      if (rec.state === 'destroyed') throw new Error('key is destroyed');
      return { keyId: rec.keyId, dek: Buffer.from(rec.dek!) }; // idempotent retry
    }
    const keyId = this.freshId('key_', (id) => this.keys.has(id)); // 128-bit, collision-checked
    const dek = randomBytes(32);
    this.keys.set(keyId, {
      keyId, itemId, epoch, provisionOpId: operationId,
      state: 'provisional', dek, createdAt: this.clock(),
    });
    this.ops.set(operationId, { operationId, kind: 'provision', keyId, itemId, epoch });
    this.trip('provision', 'after'); // mutation done; simulate lost ack
    return { keyId, dek: Buffer.from(dek) };
  }

  async commitProvision(operationId: string): Promise<void> {
    this.trip('commit', 'before');
    const op = this.ops.get(operationId);
    if (!op || op.kind !== 'provision') throw new Error('unknown provision operation');
    const rec = this.keys.get(op.keyId)!;
    if (rec.state === 'destroyed') throw new Error('destroyed is terminal; cannot reactivate');
    rec.state = 'active'; // idempotent if already active
    this.trip('commit', 'after'); // state changed; simulate lost ack
  }

  async get(keyId: string, epoch: number): Promise<Buffer> {
    this.trip('get', 'before');
    const rec = this.keys.get(keyId);
    if (!rec) throw new Error('not_found');
    if (rec.state !== 'active') throw new Error(`key not active (${rec.state})`);
    if (rec.epoch !== epoch) throw new Error('epoch mismatch');
    return Buffer.from(rec.dek!);
  }

  async destroy(operationId: string, keyId: string): Promise<DestructionReceipt> {
    this.trip('destroy', 'before');
    const prior = this.ops.get(operationId);
    if (prior) {
      if (prior.kind !== 'destroy' || prior.keyId !== keyId) {
        throw new Error('operation_id reused with different inputs');
      }
      return this.keys.get(keyId)!.receipt!; // idempotent on operation_id
    }
    const rec = this.keys.get(keyId);
    if (!rec) throw new Error('not_found');
    if (rec.state === 'destroyed' && rec.receipt) {
      this.ops.set(operationId, { operationId, kind: 'destroy', keyId }); // idempotent on key_id
      return rec.receipt;
    }
    if (rec.dek) {
      rec.dek.fill(0); // zeroize wrapped material before dropping
      rec.dek = null;
    }
    rec.state = 'destroyed';
    rec.receipt = {
      keyId,
      receiptId: this.freshId('rcpt_', (id) => this.receiptIds.has(id)),
      destroyedAt: new Date(this.clock()).toISOString(),
      attestation: this.attest(keyId, operationId),
    };
    this.receiptIds.add(rec.receipt.receiptId);
    this.ops.set(operationId, { operationId, kind: 'destroy', keyId });
    this.trip('destroy', 'after'); // destruction done; simulate lost receipt response
    return rec.receipt;
  }

  async status(keyId: string): Promise<KeyStatus> {
    this.trip('status', 'before'); // transport failure is an exception, never a value
    const rec = this.keys.get(keyId);
    if (!rec) return 'not_found';
    return rec.state;
  }

  async listStaleProvisioning(): Promise<StaleProvisioning[]> {
    this.trip('list', 'before');
    const now = this.clock();
    return [...this.keys.values()]
      .filter((r) => r.state === 'provisional')
      .map((r) => ({ operationId: r.provisionOpId, itemId: r.itemId, keyId: r.keyId, ageMs: now - r.createdAt }));
  }
}
