import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEV_COMPLETION_SECRET, type DestructionReceipt, type KeyCustodian, type KeyStatus, type ProvisionResult, type StaleProvisioning } from './custodian.js';

/**
 * Filesystem-backed reference production custodian.
 *
 * Unlike InMemoryCustodian, this is DURABLE (survives a process restart by re-reading its
 * directory) and performs a best-effort IRREVERSIBLE delete (overwrite the wrapped-key bytes,
 * then unlink), leaving a durable NON-SECRET tombstone. It holds the completion secret in its
 * own config, separate from the application database — so the app relays attestations it
 * cannot forge.
 *
 * This is the reference adapter for the integration suite (design O4). A real deployment swaps
 * it for a managed KMS / secrets service implementing the same KeyCustodian contract; the
 * filesystem here stands in for that external store, and FS-level overwrite is only
 * best-effort irreversibility — a managed KMS provides the real guarantee.
 *
 * Concurrency: methods serialize at the per-item DB lock in the authority; this store itself
 * is single-writer (adequate for the integration suite, not a high-concurrency KMS).
 */

interface KeyFile {
  keyId: string;
  itemId: string;
  epoch: number;
  operationId: string;
  state: 'provisional' | 'active';
  dekHex: string;
  createdAt: number;
}
interface Tombstone {
  keyId: string;
  receiptId: string;
  destroyedAt: string;
}
interface OpFile {
  operationId: string;
  kind: 'provision' | 'destroy';
  keyId: string;
  itemId?: string;
  epoch?: number;
}

export class FileCustodian implements KeyCustodian {
  private readonly keysDir: string;
  private readonly tombDir: string;
  private readonly opsDir: string;
  private readonly completionSecret: string;
  private readonly clock: () => number;

  constructor(rootDir: string, completionSecret: string = DEV_COMPLETION_SECRET, clock: () => number = () => Date.now()) {
    this.keysDir = path.join(rootDir, 'keys');
    this.tombDir = path.join(rootDir, 'tombstones');
    this.opsDir = path.join(rootDir, 'ops');
    for (const d of [this.keysDir, this.tombDir, this.opsDir]) mkdirSync(d, { recursive: true });
    this.completionSecret = completionSecret;
    this.clock = clock;
  }

  private keyPath(keyId: string): string { return path.join(this.keysDir, `${keyId}.json`); }
  private tombPath(keyId: string): string { return path.join(this.tombDir, `${keyId}.json`); }
  private opPath(operationId: string): string { return path.join(this.opsDir, `${operationId}.json`); }

  private readJson<T>(p: string): T | null {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  }
  private writeJson(p: string, v: unknown): void {
    writeFileSync(p, JSON.stringify(v), { encoding: 'utf8' });
  }

  private attest(keyId: string, receiptId: string, destroyedAt: string): string {
    if (/\n/.test(keyId) || /\n/.test(receiptId) || /\n/.test(destroyedAt)) throw new Error('attestation field contains a separator');
    return createHmac('sha256', this.completionSecret).update(`${keyId}\n${receiptId}\n${destroyedAt}`).digest('hex');
  }

  async provision(operationId: string, itemId: string, epoch: number): Promise<ProvisionResult> {
    const prior = this.readJson<OpFile>(this.opPath(operationId));
    if (prior) {
      if (prior.kind !== 'provision' || prior.itemId !== itemId || prior.epoch !== epoch) {
        throw new Error('operation_id reused with different inputs');
      }
      if (existsSync(this.tombPath(prior.keyId))) throw new Error('key is destroyed');
      const kf = this.readJson<KeyFile>(this.keyPath(prior.keyId));
      if (!kf) throw new Error('key is destroyed');
      return { keyId: kf.keyId, dek: Buffer.from(kf.dekHex, 'hex') }; // idempotent retry
    }
    let keyId: string;
    do { keyId = `key_${randomUUID()}`; } while (existsSync(this.keyPath(keyId)) || existsSync(this.tombPath(keyId)));
    const dek = randomBytes(32);
    this.writeJson(this.keyPath(keyId), {
      keyId, itemId, epoch, operationId, state: 'provisional', dekHex: dek.toString('hex'), createdAt: this.clock(),
    } satisfies KeyFile);
    this.writeJson(this.opPath(operationId), { operationId, kind: 'provision', keyId, itemId, epoch } satisfies OpFile);
    return { keyId, dek };
  }

  async commitProvision(operationId: string): Promise<void> {
    const op = this.readJson<OpFile>(this.opPath(operationId));
    if (!op || op.kind !== 'provision') throw new Error('unknown provision operation');
    if (existsSync(this.tombPath(op.keyId))) throw new Error('destroyed is terminal; cannot reactivate');
    const kf = this.readJson<KeyFile>(this.keyPath(op.keyId));
    if (!kf) throw new Error('destroyed is terminal; cannot reactivate');
    if (kf.state !== 'active') { kf.state = 'active'; this.writeJson(this.keyPath(op.keyId), kf); }
  }

  async get(keyId: string, epoch: number): Promise<Buffer> {
    if (existsSync(this.tombPath(keyId))) throw new Error('key not active (destroyed)');
    const kf = this.readJson<KeyFile>(this.keyPath(keyId));
    if (!kf) throw new Error('not_found');
    if (kf.state !== 'active') throw new Error(`key not active (${kf.state})`);
    if (kf.epoch !== epoch) throw new Error('epoch mismatch');
    return Buffer.from(kf.dekHex, 'hex');
  }

  async destroy(operationId: string, keyId: string): Promise<DestructionReceipt> {
    const prior = this.readJson<OpFile>(this.opPath(operationId));
    if (prior) {
      if (prior.kind !== 'destroy' || prior.keyId !== keyId) throw new Error('operation_id reused with different inputs');
      return this.receiptFor(this.readJson<Tombstone>(this.tombPath(keyId))!); // idempotent on operation_id
    }
    const existingTomb = this.readJson<Tombstone>(this.tombPath(keyId));
    if (existingTomb) {
      this.writeJson(this.opPath(operationId), { operationId, kind: 'destroy', keyId } satisfies OpFile); // idempotent on key_id
      return this.receiptFor(existingTomb);
    }
    // irreversible delete: overwrite the wrapped-key bytes, then unlink
    const kp = this.keyPath(keyId);
    if (existsSync(kp)) {
      const kf = this.readJson<KeyFile>(kp)!;
      kf.dekHex = '0'.repeat(kf.dekHex.length);
      this.writeJson(kp, kf);
      rmSync(kp, { force: true });
    }
    const tomb: Tombstone = { keyId, receiptId: `rcpt_${randomUUID()}`, destroyedAt: new Date(this.clock()).toISOString() };
    this.writeJson(this.tombPath(keyId), tomb);
    this.writeJson(this.opPath(operationId), { operationId, kind: 'destroy', keyId } satisfies OpFile);
    return this.receiptFor(tomb);
  }

  private receiptFor(tomb: Tombstone): DestructionReceipt {
    return { keyId: tomb.keyId, receiptId: tomb.receiptId, destroyedAt: tomb.destroyedAt, attestation: this.attest(tomb.keyId, tomb.receiptId, tomb.destroyedAt) };
  }

  async status(keyId: string): Promise<KeyStatus> {
    if (existsSync(this.tombPath(keyId))) return 'destroyed';
    const kf = this.readJson<KeyFile>(this.keyPath(keyId));
    if (!kf) return 'not_found';
    return kf.state;
  }

  async listStaleProvisioning(): Promise<StaleProvisioning[]> {
    const now = this.clock();
    const out: StaleProvisioning[] = [];
    for (const f of readdirSync(this.keysDir)) {
      if (!f.endsWith('.json')) continue;
      const kf = this.readJson<KeyFile>(path.join(this.keysDir, f));
      if (kf && kf.state === 'provisional') out.push({ operationId: kf.operationId, itemId: kf.itemId, keyId: kf.keyId, ageMs: now - kf.createdAt });
    }
    return out;
  }

  /** Test helper: remove the entire keystore directory. */
  static wipe(rootDir: string): void {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
