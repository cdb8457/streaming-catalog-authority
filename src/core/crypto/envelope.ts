import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM identity envelope (design §3).
 *
 * Serialized: version(1) ‖ nonce(12) ‖ ciphertext ‖ tag(16).
 * AAD = item_id ‖ key_epoch ‖ schema_version ‖ field — binds each ciphertext to
 * its exact slot, generation, and schema, so it cannot be swapped between
 * fields/refs/items/epochs. A fresh random 96-bit nonce is used per encryption.
 *
 * DEKs are Buffers (never strings) and should be zeroized after use (§7.2).
 */

const VERSION = 1;
const NONCE_LEN = 12; // 96-bit GCM nonce
const TAG_LEN = 16;
const DEK_LEN = 32; // AES-256
export const SCHEMA_VERSION = 1;

export interface Aad {
  itemId: string;
  keyEpoch: number;
  schemaVersion: number;
  field: string; // closed format: 'identity' or 'ref:<ref_type>'
}

const ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELD_RE = /^(identity|ref:[a-z0-9_]{1,32})$/;

/** 4-byte big-endian length prefix + bytes — unambiguous concatenation. */
function lp(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

/**
 * Builds the AAD as a length-prefixed binary encoding of validated fields, so no
 * choice of field values can be made to collide (a `|`-join cannot bind safely:
 * {itemId:"a|1",epoch:2,...} would otherwise match {itemId:"a",epoch:1,...}).
 */
function aadBuffer(a: Aad): Buffer {
  if (!ITEM_ID_RE.test(a.itemId)) throw new Error('AAD: itemId must be an opaque uuid');
  if (!Number.isSafeInteger(a.keyEpoch) || a.keyEpoch < 0) throw new Error('AAD: keyEpoch must be a nonnegative safe integer');
  if (!Number.isSafeInteger(a.schemaVersion) || a.schemaVersion < 0) throw new Error('AAD: schemaVersion must be a nonnegative safe integer');
  if (!FIELD_RE.test(a.field)) throw new Error('AAD: field must be "identity" or "ref:<ref_type>"');
  return Buffer.concat([
    lp(Buffer.from(a.itemId, 'utf8')),
    lp(u64(a.keyEpoch)),
    lp(u64(a.schemaVersion)),
    lp(Buffer.from(a.field, 'utf8')),
  ]);
}

export function encrypt(dek: Buffer, plaintext: Buffer, aad: Aad): Buffer {
  if (dek.length !== DEK_LEN) throw new Error('DEK must be 32 bytes');
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce);
  cipher.setAAD(aadBuffer(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, ct, tag]);
}

export function decrypt(dek: Buffer, envelope: Buffer, aad: Aad): Buffer {
  if (dek.length !== DEK_LEN) throw new Error('DEK must be 32 bytes');
  if (envelope.length < 1 + NONCE_LEN + TAG_LEN) throw new Error('envelope too short');
  if (envelope[0] !== VERSION) throw new Error('unsupported envelope version');
  const nonce = envelope.subarray(1, 1 + NONCE_LEN);
  const tag = envelope.subarray(envelope.length - TAG_LEN);
  const ct = envelope.subarray(1 + NONCE_LEN, envelope.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', dek, nonce);
  decipher.setAAD(aadBuffer(aad));
  decipher.setAuthTag(tag);
  // throws on any tamper, AAD mismatch (wrong field/item/epoch/schema), or bad tag
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function encryptUtf8(dek: Buffer, text: string, aad: Aad): Buffer {
  return encrypt(dek, Buffer.from(text, 'utf8'), aad);
}

export function decryptUtf8(dek: Buffer, envelope: Buffer, aad: Aad): string {
  const buf = decrypt(dek, envelope, aad);
  try {
    return buf.toString('utf8');
  } finally {
    buf.fill(0); // zeroize the temporary plaintext buffer (§7.2)
  }
}

/** Best-effort zeroization of a DEK/plaintext Buffer (§7.2). */
export function zeroize(buf: Buffer): void {
  buf.fill(0);
}
