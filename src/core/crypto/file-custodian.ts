import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import type { DestructionReceipt, KeyCustodian, KeyStatus, ProvisionResult, StaleProvisioning } from './custodian.js';

/**
 * Filesystem-backed REFERENCE custodian harness.
 *
 * Hardened: ids are hashed into filenames with resolved-path containment (no traversal);
 * DEKs are stored WRAPPED under a KEK (never raw); writes are atomic (temp -> fsync ->
 * rename, mode 0600); destroy is crash-recoverable via a journal and refuses an unknown key;
 * the completion secret and KEK are supplied explicitly (no importable default).
 *
 * It is still a REFERENCE harness, NOT the production adapter: it runs in-process (so the
 * trust boundary is not enforced — a real deployment runs the custodian as a separate
 * service / managed KMS holding the secret+KEK outside the app), and FS overwrite is only
 * best-effort physical irreversibility. The design O4 production target is a managed-KMS
 * implementation of this same KeyCustodian interface, not this class.
 */

interface KeyFile {
  keyId: string;
  itemId: string;
  epoch: number;
  operationId: string;
  state: 'provisional' | 'active';
  wrappedHex: string; // DEK encrypted under the KEK (never the raw DEK)
  createdAt: number;
}
interface Tombstone { keyId: string; receiptId: string; destroyedAt: string; }
interface OpFile { operationId: string; kind: 'provision' | 'destroy'; keyId: string; itemId?: string; epoch?: number; }
interface Journal { keyId: string; receiptId: string; destroyedAt: string; }

export class FileCustodian implements KeyCustodian {
  private readonly root: string;
  private readonly keysDir: string;
  private readonly tombDir: string;
  private readonly opsDir: string;
  private readonly journalDir: string;
  private readonly completionSecret: string;
  private readonly kek: Buffer;
  private readonly clock: () => number;

  constructor(rootDir: string, completionSecret: string, kek: Buffer, clock: () => number = () => Date.now()) {
    if (!completionSecret) throw new Error('completionSecret is required');
    if (kek.length !== 32) throw new Error('KEK must be 32 bytes');
    if (!rootDir) throw new Error('rootDir is required');
    this.root = path.resolve(rootDir);
    this.keysDir = path.join(this.root, 'keys');
    this.tombDir = path.join(this.root, 'tombstones');
    this.opsDir = path.join(this.root, 'ops');
    this.journalDir = path.join(this.root, 'journal');
    for (const d of [this.keysDir, this.tombDir, this.opsDir, this.journalDir]) mkdirSync(d, { recursive: true });
    this.completionSecret = completionSecret;
    this.kek = kek;
    this.clock = clock;
    this.recover(); // finish any destroy interrupted by a crash
  }

  // --- path safety ----------------------------------------------------------
  private safe(dir: string, id: string): string {
    const name = `${createHash('sha256').update(id).digest('hex')}.json`; // hashed -> no traversal
    const p = path.join(dir, name);
    if (!path.resolve(p).startsWith(dir + path.sep)) throw new Error('path containment violation');
    return p;
  }
  private keyPath(keyId: string): string { return this.safe(this.keysDir, keyId); }
  private tombPath(keyId: string): string { return this.safe(this.tombDir, keyId); }
  private opPath(op: string): string { return this.safe(this.opsDir, op); }
  private journalPath(keyId: string): string { return this.safe(this.journalDir, keyId); }

  // --- atomic IO ------------------------------------------------------------
  private read<T>(p: string): T | null {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  }
  private writeAtomic(p: string, value: unknown): void {
    const tmp = `${p}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  }

  // --- KEK wrap/unwrap (DEKs are never stored raw) --------------------------
  private wrap(dek: Buffer, keyId: string): string {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.kek, nonce);
    c.setAAD(Buffer.from(keyId, 'utf8'));
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('hex');
  }
  private unwrap(wrappedHex: string, keyId: string): Buffer {
    const b = Buffer.from(wrappedHex, 'hex');
    const nonce = b.subarray(0, 12);
    const tag = b.subarray(b.length - 16);
    const ct = b.subarray(12, b.length - 16);
    const d = createDecipheriv('aes-256-gcm', this.kek, nonce);
    d.setAAD(Buffer.from(keyId, 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }

  private attest(keyId: string, receiptId: string, destroyedAt: string): string {
    if (/\n/.test(keyId) || /\n/.test(receiptId) || /\n/.test(destroyedAt)) throw new Error('attestation field contains a separator');
    return createHmac('sha256', this.completionSecret).update(`${keyId}\n${receiptId}\n${destroyedAt}`).digest('hex');
  }
  private receiptFor(t: Tombstone): DestructionReceipt {
    return { keyId: t.keyId, receiptId: t.receiptId, destroyedAt: t.destroyedAt, attestation: this.attest(t.keyId, t.receiptId, t.destroyedAt) };
  }

  // crash recovery: complete any destroy that journaled but didn't finish
  private recover(): void {
    for (const f of readdirSync(this.journalDir)) {
      if (!f.endsWith('.json')) continue;
      const j = this.read<Journal>(path.join(this.journalDir, f));
      if (!j) { rmSync(path.join(this.journalDir, f), { force: true }); continue; }
      this.finishDestroy(j);
    }
  }
  private finishDestroy(j: Journal): void {
    const kp = this.keyPath(j.keyId);
    if (existsSync(kp)) {
      const kf = this.read<KeyFile>(kp)!;
      kf.wrappedHex = '0'.repeat(kf.wrappedHex.length); // overwrite wrapped bytes
      this.writeAtomic(kp, kf);
      rmSync(kp, { force: true });
    }
    if (!existsSync(this.tombPath(j.keyId))) {
      this.writeAtomic(this.tombPath(j.keyId), { keyId: j.keyId, receiptId: j.receiptId, destroyedAt: j.destroyedAt } satisfies Tombstone);
    }
    rmSync(this.journalPath(j.keyId), { force: true });
  }

  // --- contract -------------------------------------------------------------
  async provision(operationId: string, itemId: string, epoch: number): Promise<ProvisionResult> {
    const prior = this.read<OpFile>(this.opPath(operationId));
    if (prior) {
      if (prior.kind !== 'provision' || prior.itemId !== itemId || prior.epoch !== epoch) throw new Error('operation_id reused with different inputs');
      if (existsSync(this.tombPath(prior.keyId))) throw new Error('key is destroyed');
      const kf = this.read<KeyFile>(this.keyPath(prior.keyId));
      if (!kf) throw new Error('key is destroyed');
      return { keyId: kf.keyId, dek: this.unwrap(kf.wrappedHex, kf.keyId) };
    }
    let keyId: string;
    do { keyId = `key_${randomUUID()}`; } while (existsSync(this.keyPath(keyId)) || existsSync(this.tombPath(keyId)));
    const dek = randomBytes(32);
    this.writeAtomic(this.keyPath(keyId), {
      keyId, itemId, epoch, operationId, state: 'provisional', wrappedHex: this.wrap(dek, keyId), createdAt: this.clock(),
    } satisfies KeyFile);
    this.writeAtomic(this.opPath(operationId), { operationId, kind: 'provision', keyId, itemId, epoch } satisfies OpFile);
    return { keyId, dek };
  }

  async commitProvision(operationId: string): Promise<void> {
    const op = this.read<OpFile>(this.opPath(operationId));
    if (!op || op.kind !== 'provision') throw new Error('unknown provision operation');
    if (existsSync(this.tombPath(op.keyId))) throw new Error('destroyed is terminal; cannot reactivate');
    const kf = this.read<KeyFile>(this.keyPath(op.keyId));
    if (!kf) throw new Error('destroyed is terminal; cannot reactivate');
    if (kf.state !== 'active') { kf.state = 'active'; this.writeAtomic(this.keyPath(op.keyId), kf); }
  }

  async get(keyId: string, epoch: number): Promise<Buffer> {
    if (existsSync(this.tombPath(keyId))) throw new Error('key not active (destroyed)');
    const kf = this.read<KeyFile>(this.keyPath(keyId));
    if (!kf) throw new Error('not_found');
    if (kf.state !== 'active') throw new Error(`key not active (${kf.state})`);
    if (kf.epoch !== epoch) throw new Error('epoch mismatch');
    return this.unwrap(kf.wrappedHex, kf.keyId);
  }

  async destroy(operationId: string, keyId: string): Promise<DestructionReceipt> {
    const prior = this.read<OpFile>(this.opPath(operationId));
    if (prior) {
      if (prior.kind !== 'destroy' || prior.keyId !== keyId) throw new Error('operation_id reused with different inputs');
      return this.receiptFor(this.read<Tombstone>(this.tombPath(keyId))!);
    }
    const existingTomb = this.read<Tombstone>(this.tombPath(keyId));
    if (existingTomb) {
      this.writeAtomic(this.opPath(operationId), { operationId, kind: 'destroy', keyId } satisfies OpFile);
      return this.receiptFor(existingTomb);
    }
    // REFUSE to fabricate a tombstone for a key we have no evidence ever existed
    if (!existsSync(this.keyPath(keyId))) throw new Error('not_found');

    const j: Journal = { keyId, receiptId: `rcpt_${randomUUID()}`, destroyedAt: new Date(this.clock()).toISOString() };
    this.writeAtomic(this.journalPath(keyId), j); // crash fence: intent recorded first
    this.finishDestroy(j);                          // overwrite+unlink key, write tombstone, clear journal
    this.writeAtomic(this.opPath(operationId), { operationId, kind: 'destroy', keyId } satisfies OpFile);
    return this.receiptFor({ keyId, receiptId: j.receiptId, destroyedAt: j.destroyedAt });
  }

  async status(keyId: string): Promise<KeyStatus> {
    if (existsSync(this.tombPath(keyId))) return 'destroyed';
    const kf = this.read<KeyFile>(this.keyPath(keyId));
    if (!kf) return 'not_found';
    return kf.state;
  }

  async listStaleProvisioning(): Promise<StaleProvisioning[]> {
    const now = this.clock();
    const out: StaleProvisioning[] = [];
    for (const f of readdirSync(this.keysDir)) {
      if (!f.endsWith('.json')) continue;
      const kf = this.read<KeyFile>(path.join(this.keysDir, f));
      if (kf && kf.state === 'provisional') out.push({ operationId: kf.operationId, itemId: kf.itemId, keyId: kf.keyId, ageMs: now - kf.createdAt });
    }
    return out;
  }

  static wipe(rootDir: string): void {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
