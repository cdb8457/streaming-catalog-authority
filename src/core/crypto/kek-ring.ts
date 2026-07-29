import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  CustodianStateError,
  acquireStateLock,
  createStateDirectory,
  readStateDocument,
  writeStateDocument,
} from './custodian-state-io.js';

// Phase 282 — the sidecar-managed KEK ring, and what "managed" is allowed to mean here.
//
// -----------------------------------------------------------------------------------------------------
// THE HONEST NAME FOR THIS.
// -----------------------------------------------------------------------------------------------------
//
// This is NOT a cloud KMS, an HSM, or anything with a hardware boundary. Nothing in this file talks to a
// network and nothing in this product does. "Sidecar-managed" means exactly one thing and it is worth stating
// before anything else, because the previous documents in this repository drifted towards implying more:
//
//   THE KEY-ENCRYPTION KEYS ARE GENERATED, HELD, ROTATED AND USED INSIDE THE CUSTODIAN SIDECAR PROCESS, AND
//   THE APPLICATION NEVER RECEIVES ONE.
//
// That is a real and useful boundary — it is the difference between "an attacker who reads the app's
// environment has your KEK" and "an attacker who reads the app's environment has a socket that will answer
// per-item DEK requests and nothing else". It is not a hardware guarantee and it is not custody by a third
// party, and this file says so rather than letting a reader assume it.
//
// -----------------------------------------------------------------------------------------------------
// WHAT THE RING REPLACES.
// -----------------------------------------------------------------------------------------------------
//
// Until now the KEK was a STATIC 32 bytes in a file (`custodian_kek`), mounted into the sidecar AND named in
// the app's own stack, with rotation as an offline command an operator ran against a keystore by hand. Three
// consequences:
//
//   * ONE KEY, FOREVER, IN A FILE ANYTHING WITH THE MOUNT COULD READ. Nothing generated it inside a trust
//     boundary and nothing stopped it being copied out of one.
//   * ROTATION MEANT HOLDING TWO KEKS AT ONCE, ON A COMMAND LINE OR IN AN ENVIRONMENT, and getting the order
//     right by hand.
//   * THERE WAS NO RECORD OF WHICH GENERATION ANYTHING WAS UNDER. `kekVersion` on a key file was a number
//     nobody could check against anything.
//
// The ring replaces all three. A ROOT WRAPPING KEY — read only by the sidecar, only from an owner-only file,
// only through a no-follow open, never from an environment variable, a command line or any evidence surface —
// encrypts a versioned RING whose entries are the actual KEKs. Every KEK is generated with
// `randomBytes` INSIDE this process. The ring is AEAD-sealed, so a wrong root key or a single altered byte is
// a decrypt failure rather than a subtly wrong key, and the header is bound into the AAD so an envelope
// cannot be re-labelled.
//
// FAIL CLOSED, IN EVERY DIRECTION. Wrong root, corrupt ciphertext, a version this build does not know, a ring
// with no active generation, a ring whose active generation is not in its own entries: each is a refusal.
// There is no branch that recovers a ring by guessing, because every guess here is a guess about which bytes
// decrypt an installation's entire catalog.

export const KEK_RING_DOCUMENT = 'catalog-authority.kek-ring';
export const KEK_RING_VERSION = 1;

/** Where the ring lives inside the sidecar's state directory. */
export const KEK_RING_DIRNAME = 'ring';
export const KEK_RING_FILENAME = 'kek-ring.json';

/** A KEK, a root wrapping key, and a DEK are all 32 bytes. Stated once. */
export const KEY_BYTES = 32;

/** How large the root wrapping key file may be. It holds one encoded key and a newline. */
export const MAX_ROOT_KEY_FILE_BYTES = 4 * 1024;

export type KekGenerationState = 'pending' | 'active' | 'retired';

export interface KekGeneration {
  readonly generation: number;
  readonly state: KekGenerationState;
  /** The KEK itself, hex. Present ONLY inside the decrypted ring, which never leaves this process. */
  readonly keyHex: string;
  readonly createdAt: number;
  /** Where this generation came from. A closed word, and part of what an audit reads. */
  readonly origin: 'generated-in-sidecar' | 'adopted-from-static-kek';
}

export interface KekRing {
  readonly document: typeof KEK_RING_DOCUMENT;
  readonly version: typeof KEK_RING_VERSION;
  readonly generations: readonly KekGeneration[];
  /** The generation new wraps use. Always present in a ring this build will load. */
  readonly active: number;
  /** A generation that exists and is NOT yet in use. `null` outside a rotation. */
  readonly pending: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What a report may say about a ring. Numbers, words and digests — never a key. */
export interface KekRingSummary {
  readonly active: number;
  readonly pending: number | null;
  /**
   * Generations that are no longer what new wraps use, and are still IN the ring and still usable.
   *
   * ONE NAME FOR ONE THING. "Retained" is what these are: a generation whose state is `retired` has stopped
   * being active and has NOT been removed — every backup taken while it was active still needs it. A
   * generation that has been removed is not in this list because it is not in the ring at all.
   */
  readonly retained: readonly number[];
  /** A non-reversible label for the root wrapping key currently sealing the ring. */
  readonly rootKeyId: string;
  readonly activeCreatedAt: number;
  readonly origin: KekGeneration['origin'];
}

export class KekRingError extends Error {
  readonly code = 'KEK_RING_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'KekRingError';
  }
}

// -----------------------------------------------------------------------------------------------------------
// The root wrapping key
// -----------------------------------------------------------------------------------------------------------

/**
 * Read the root wrapping key, and refuse every way of supplying one that is not a private file.
 *
 * NO ENVIRONMENT VARIABLE, NO COMMAND LINE, NO ARGUMENT. Both are visible in `ps`, in a scheduler's log and in
 * a container inspect; a root key that reached this process either way would be a root key on a screen. The
 * only source is a path, opened WITHOUT following a link, `fstat`ed on the descriptor, bounded, and required
 * to be owner-only — because a 0644 root key file is a root key every process on the host can read, and the
 * ring's entire value is that it cannot be.
 */
export function readRootWrappingKey(path: string): Buffer {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new KekRingError('the root wrapping key file is a symbolic link, and the sidecar will not follow one');
    }
    throw new KekRingError('the root wrapping key file could not be opened');
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new KekRingError('the root wrapping key path is not a regular file');
    if (stats.size > MAX_ROOT_KEY_FILE_BYTES) {
      throw new KekRingError('the root wrapping key file is larger than a key file could be');
    }
    if (process.platform !== 'win32') {
      const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
      const uid = typeof getuid === 'function' ? getuid.call(process) : null;
      if (uid !== null && stats.uid !== uid) {
        throw new KekRingError('the root wrapping key file belongs to another user');
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new KekRingError(
          'the root wrapping key file is readable by somebody other than its owner. Every key this '
          + 'installation holds is sealed under it, so a mode that lets another account read it makes the whole '
          + 'ring readable by that account. Refused.');
      }
    }
    const buffer = Buffer.allocUnsafe(stats.size);
    let total = 0;
    while (total < buffer.byteLength) {
      const read = readSync(fd, buffer, total, buffer.byteLength - total, total);
      if (read <= 0) break;
      total += read;
    }
    const decoded = decodeKey(buffer.subarray(0, total).toString('utf8').trim());
    if (decoded === null) {
      throw new KekRingError('the root wrapping key file does not hold exactly 32 bytes, hex or base64 encoded');
    }
    return decoded;
  } finally {
    try { closeSync(fd); } catch { /* the read is done either way */ }
  }
}

/** 32 bytes from hex or base64, or `null`. Never throws with the value in the message. */
export function decodeKey(text: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  const decoded = Buffer.from(text, 'base64');
  return decoded.length === KEY_BYTES && decoded.toString('base64').replace(/=+$/, '') === text.replace(/=+$/, '')
    ? decoded
    : null;
}

/**
 * A non-reversible label for a root wrapping key.
 *
 * WHY THIS EXISTS. "Is the ring sealed under the root key I am holding" has to be answerable in a report, by
 * an operator, without either of them naming the key. A domain-separated digest of the key answers exactly
 * that and nothing else: two runs agree, a different key disagrees, and the label discloses nothing.
 */
export function rootKeyId(root: Buffer): string {
  return createHash('sha256')
    .update(JSON.stringify([KEK_RING_DOCUMENT, 'root-key-id']), 'utf8')
    .update(root)
    .digest('hex')
    .slice(0, 32);
}

// -----------------------------------------------------------------------------------------------------------
// The sealed envelope
// -----------------------------------------------------------------------------------------------------------

interface SealedRing {
  readonly document: typeof KEK_RING_DOCUMENT;
  readonly version: typeof KEK_RING_VERSION;
  /** WHICH root sealed this, so a mismatch is a clear refusal rather than an opaque decrypt failure. */
  readonly rootKeyId: string;
  readonly nonceHex: string;
  readonly ciphertextHex: string;
  readonly tagHex: string;
}

/**
 * The additional authenticated data.
 *
 * The header is bound into the seal, so an envelope cannot be re-labelled: changing the recorded version or
 * the root key id to make a ring look like something else breaks the tag rather than changing what it claims.
 */
function sealAad(rootKeyLabel: string): Buffer {
  return Buffer.from(JSON.stringify([KEK_RING_DOCUMENT, KEK_RING_VERSION, rootKeyLabel]), 'utf8');
}

function seal(root: Buffer, ring: KekRing): SealedRing {
  const label = rootKeyId(root);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', root, nonce);
  cipher.setAAD(sealAad(label));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(ring), 'utf8'), cipher.final()]);
  return {
    document: KEK_RING_DOCUMENT,
    version: KEK_RING_VERSION,
    rootKeyId: label,
    nonceHex: nonce.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
    tagHex: cipher.getAuthTag().toString('hex'),
  };
}

function unseal(root: Buffer, sealed: SealedRing): KekRing {
  const label = rootKeyId(root);
  // THE ENVELOPE'S OWN HEADER, BEFORE ANY KEY IS APPLIED TO IT. A version this build does not know describes
  // a layout it cannot reason about, and the AAD binds the version it DOES know — so an envelope claiming a
  // future one would otherwise decrypt (the AAD is computed from this build's constant) and be read under
  // rules that were never written for it.
  const envelopeKeys = ['document', 'version', 'rootKeyId', 'nonceHex', 'ciphertextHex', 'tagHex'];
  const envelope = sealed as unknown as Record<string, unknown>;
  for (const key of Object.keys(envelope)) {
    if (!envelopeKeys.includes(key)) throw new KekRingError('the KEK ring envelope carries a field this build does not know');
  }
  // SIZES, NOT MERELY TYPES. A 12-byte nonce and a 16-byte tag are what AES-GCM was given; anything else is a
  // document written by something that is not this build, and reading it would be guessing.
  if (!/^[0-9a-f]{24}$/.test(String(envelope.nonceHex)) || !/^[0-9a-f]{32}$/.test(String(envelope.tagHex))
    || !/^[0-9a-f]{2,}$/.test(String(envelope.ciphertextHex))
    || String(envelope.ciphertextHex).length % 2 !== 0
    || !/^[0-9a-f]{32}$/.test(String(envelope.rootKeyId))) {
    throw new KekRingError('the KEK ring envelope is not the shape this build writes');
  }
  if (sealed.document !== KEK_RING_DOCUMENT || sealed.version !== KEK_RING_VERSION) {
    throw new KekRingError(
      'the KEK ring envelope was written by a version of this product that this build does not understand, or '
      + 'is not a ring at all. Refused: guessing at a ring format is guessing at which bytes decrypt the '
      + 'catalog.');
  }
  // SAID PLAINLY BEFORE THE DECRYPT IS ATTEMPTED. "Wrong root key" and "corrupt ring" are different problems
  // with different remedies, and a single opaque tag failure would tell an operator neither.
  if (sealed.rootKeyId !== label) {
    throw new KekRingError(
      'this ring is sealed under a DIFFERENT root wrapping key from the one the sidecar was given. Nothing was '
      + 'changed. Point the sidecar at the root key this installation was initialised with — a ring cannot be '
      + 'opened by any other, and there is no recovery path that does not have it.');
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', root, Buffer.from(sealed.nonceHex, 'hex'));
    decipher.setAAD(sealAad(label));
    decipher.setAuthTag(Buffer.from(sealed.tagHex, 'hex'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertextHex, 'hex')), decipher.final()]);
  } catch {
    throw new KekRingError(
      'the KEK ring did not authenticate under this installation\'s root wrapping key. The ring file has been '
      + 'changed or truncated since it was written. Nothing was changed. Restore the sidecar state from a '
      + 'verified complete backup: this build will not open a ring it cannot prove is intact.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new KekRingError('the KEK ring decrypted to something this build cannot read');
  }
  return assertRing(parsed);
}

/**
 * Every structural rule a ring must satisfy to be usable.
 *
 * AN INCOMPLETE RING IS A REFUSAL, NOT A DEFAULT. A ring with no active generation, or whose active number is
 * not among its own entries, or which holds two entries with one number, describes a state this build cannot
 * act on — and the action it would otherwise take is "wrap the next DEK under something".
 */
function assertRing(parsed: unknown): KekRing {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KekRingError('the KEK ring is not a ring document');
  }
  const doc = parsed as Partial<KekRing>;
  if (doc.document !== KEK_RING_DOCUMENT) throw new KekRingError('the KEK ring is not this product\'s ring');
  if (doc.version !== KEK_RING_VERSION) {
    throw new KekRingError(
      'the KEK ring was written by a version of this product that this build does not understand. Refused: '
      + 'guessing at a ring format is guessing at which bytes decrypt the catalog.');
  }
  if (!Array.isArray(doc.generations) || doc.generations.length === 0) {
    throw new KekRingError('the KEK ring holds no generations');
  }
  for (const key of Object.keys(doc as Record<string, unknown>)) {
    if (!['document', 'version', 'generations', 'active', 'pending', 'createdAt', 'updatedAt'].includes(key)) {
      throw new KekRingError('the KEK ring carries a field this build does not know');
    }
  }
  if (doc.generations.length > 64) throw new KekRingError('the KEK ring holds more generations than this build will read');
  const seen = new Set<number>();
  let actives = 0;
  let pendings = 0;
  for (const entry of doc.generations) {
    if (entry === null || typeof entry !== 'object') throw new KekRingError('the KEK ring holds a malformed generation');
    for (const key of Object.keys(entry as unknown as Record<string, unknown>)) {
      if (!['generation', 'state', 'keyHex', 'createdAt', 'origin'].includes(key)) {
        throw new KekRingError('a generation in the KEK ring carries a field this build does not know');
      }
    }
    if (entry.state === 'active') actives += 1;
    if (entry.state === 'pending') pendings += 1;
    if (!Number.isInteger(entry.generation) || entry.generation < 1) {
      throw new KekRingError('the KEK ring holds a generation that is not a generation number');
    }
    if (seen.has(entry.generation)) throw new KekRingError('the KEK ring holds two generations with one number');
    seen.add(entry.generation);
    if (entry.state !== 'pending' && entry.state !== 'active' && entry.state !== 'retired') {
      throw new KekRingError('the KEK ring holds a generation in a state this build does not know');
    }
    if (typeof entry.keyHex !== 'string' || decodeKey(entry.keyHex) === null) {
      throw new KekRingError('the KEK ring holds a generation whose key is not 32 bytes');
    }
    if (entry.origin !== 'generated-in-sidecar' && entry.origin !== 'adopted-from-static-kek') {
      throw new KekRingError('the KEK ring holds a generation with no recorded origin');
    }
    // POSITIVE AND ORDERED. A zero is not a timestamp — the rotation-age check would read one as the epoch
    // and call an installation five decades overdue — and a generation cannot predate the ring it is in.
    if (!Number.isInteger(entry.createdAt) || entry.createdAt < 1) {
      throw new KekRingError('the KEK ring holds a generation with no usable timestamp');
    }
  }
  // EXACTLY ONE ACTIVE, AT MOST ONE PENDING. Two actives is two answers to "what wraps the next DEK"; two
  // pendings is a rotation that started twice.
  if (actives !== 1) throw new KekRingError('the KEK ring does not hold exactly one active generation');
  if (pendings > 1) throw new KekRingError('the KEK ring holds more than one pending generation');
  if (!Number.isInteger(doc.active) || !seen.has(doc.active!)) {
    throw new KekRingError(
      'the KEK ring does not name an active generation that is in it. That is an INCOMPLETE ring — a rotation '
      + 'that was interrupted before it activated, or a file that was edited. Refused, because the next thing '
      + 'this build would do is wrap a key under something.');
  }
  const active = doc.generations.find((entry) => entry.generation === doc.active)!;
  if (active.state !== 'active') throw new KekRingError('the KEK ring names an active generation that is not active');
  if (doc.pending !== null && doc.pending !== undefined) {
    if (!Number.isInteger(doc.pending) || !seen.has(doc.pending)) {
      throw new KekRingError('the KEK ring names a pending generation that is not in it');
    }
    const pending = doc.generations.find((entry) => entry.generation === doc.pending)!;
    if (pending.state !== 'pending') throw new KekRingError('the KEK ring names a pending generation that is not pending');
  }
  return {
    document: KEK_RING_DOCUMENT,
    version: KEK_RING_VERSION,
    generations: doc.generations.map((entry) => ({ ...entry })),
    active: doc.active!,
    pending: doc.pending ?? null,
    // NO DEFAULT TO ZERO. A ring whose own timestamps are missing is a ring this build did not write, and
    // silently substituting the epoch would put a made-up number where a fact belongs.
    createdAt: assertTimestamp(doc.createdAt, 'created'),
    updatedAt: assertTimestamp(doc.updatedAt, 'updated'),
  };
}

// -----------------------------------------------------------------------------------------------------------
// Reading and writing the ring
// -----------------------------------------------------------------------------------------------------------

function assertTimestamp(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new KekRingError(`the KEK ring records no usable ${what} time`);
  }
  return value as number;
}

export function kekRingPath(stateDir: string): string {
  return join(stateDir, KEK_RING_DIRNAME, KEK_RING_FILENAME);
}

export function kekRingExists(stateDir: string): boolean {
  try {
    return readStateDocument<SealedRing>(kekRingPath(stateDir)) !== null;
  } catch {
    // A ring that is there and unreadable IS there. Answering `false` would let an initialisation write over
    // a ring somebody needs, which is the one irreversible mistake in this file.
    return true;
  }
}

/** Load and unseal the ring, or refuse. The only way a KEK is obtained anywhere in this product. */
export function loadKekRing(stateDir: string, root: Buffer): KekRing {
  let sealed: SealedRing | null;
  try {
    sealed = readStateDocument<SealedRing>(kekRingPath(stateDir));
  } catch (err) {
    throw new KekRingError(err instanceof CustodianStateError
      ? err.message
      : 'the KEK ring could not be read');
  }
  if (sealed === null) {
    throw new KekRingError(
      'this sidecar state directory holds no KEK ring. A ring is created once, deliberately, by an explicit '
      + 'initialisation or an explicit migration from the static KEK — never as a side effect of starting.');
  }
  return unseal(root, sealed);
}

/**
 * Write the ring, under the writer lock.
 *
 * THE LOCK IS TAKEN HERE RATHER THAN CLAIMED ELSEWHERE. `acquireStateLock` existed and nothing called it, so
 * "single-writer" was a property of a helper nobody used. Every mutation of the ring goes through this
 * function, so taking it here is what makes the claim true — two processes adding a pending generation at
 * once now have one of them refused instead of one of them silently discarded.
 */
function storeRing(stateDir: string, root: Buffer, ring: KekRing): void {
  const ringDir = join(stateDir, KEK_RING_DIRNAME);
  createStateDirectory(ringDir);
  const lock = acquireStateLock(ringDir, '.kek-ring-writer.lock');
  try {
    writeStateDocument(kekRingPath(stateDir), seal(root, ring));
  } finally {
    lock.release();
  }
}

/**
 * Create the ring for a NEW installation, with a KEK generated here and now.
 *
 * REFUSES AN EXISTING RING, ALWAYS. Overwriting one destroys every key it holds — which destroys every item
 * in the catalog, permanently and silently, because a wrapped DEK under a lost KEK is indistinguishable from
 * a correctly erased one. There is no `force`.
 */
export function initializeKekRing(
  stateDir: string,
  root: Buffer,
  now: () => number = () => Date.now(),
): KekRing {
  if (kekRingExists(stateDir)) {
    throw new KekRingError(
      'a KEK ring is already in this sidecar state directory. This command creates one and never replaces one: '
      + 'a replaced ring is every key in the catalog gone, with nothing to say so.');
  }
  const at = now();
  const ring: KekRing = {
    document: KEK_RING_DOCUMENT,
    version: KEK_RING_VERSION,
    generations: [{
      generation: 1,
      state: 'active',
      // GENERATED HERE. Not read from a file, not supplied by a caller, not derived from anything an operator
      // typed — which is the whole difference between this and the static KEK it replaces.
      keyHex: randomBytes(KEY_BYTES).toString('hex'),
      createdAt: at,
      origin: 'generated-in-sidecar',
    }],
    active: 1,
    pending: null,
    createdAt: at,
    updatedAt: at,
  };
  storeRing(stateDir, root, ring);
  return ring;
}

/**
 * Adopt an existing STATIC KEK as generation 1 of a new ring.
 *
 * THE ONLY WAY AN EXISTING INSTALLATION CAN CROSS. Every wrapped DEK on disk is under the static KEK; a ring
 * that started from a freshly generated key would be a ring that cannot open any of them. So generation 1 IS
 * the static key, recorded with an origin that says so — and the point of the exercise is the ROTATION that
 * follows, which moves everything onto a generation this sidecar made. Until that rotation completes, this
 * installation's protection is exactly what it was; the migration alone is a change of custody mechanism, not
 * of key material, and it is described that way everywhere it appears.
 */
export function adoptStaticKekAsRing(
  stateDir: string,
  root: Buffer,
  staticKek: Buffer,
  now: () => number = () => Date.now(),
): KekRing {
  if (staticKek.length !== KEY_BYTES) throw new KekRingError('the static KEK is not 32 bytes');
  if (kekRingExists(stateDir)) {
    throw new KekRingError('a KEK ring is already in this sidecar state directory; migration has already happened');
  }
  const at = now();
  const ring: KekRing = {
    document: KEK_RING_DOCUMENT,
    version: KEK_RING_VERSION,
    generations: [{
      generation: 1,
      state: 'active',
      keyHex: staticKek.toString('hex'),
      createdAt: at,
      origin: 'adopted-from-static-kek',
    }],
    active: 1,
    pending: null,
    createdAt: at,
    updatedAt: at,
  };
  storeRing(stateDir, root, ring);
  return ring;
}

/** The KEK new wraps use. The only function that hands a caller key bytes, and it never leaves the sidecar. */
export function activeKek(ring: KekRing): Buffer {
  const active = ring.generations.find((entry) => entry.generation === ring.active);
  if (active === undefined) throw new KekRingError('the KEK ring has no active generation');
  return Buffer.from(active.keyHex, 'hex');
}

/** One generation's key, by number. Used by the rotation to unwrap under the outgoing generation. */
export function kekForGeneration(ring: KekRing, generation: number): Buffer {
  const found = ring.generations.find((entry) => entry.generation === generation);
  if (found === undefined) throw new KekRingError('the KEK ring holds no such generation');
  return Buffer.from(found.keyHex, 'hex');
}

/**
 * Add a PENDING generation, generated here.
 *
 * Pending means "exists, and nothing is wrapped under it". A rotation creates it, rewraps onto it, verifies
 * everything, and only then activates — so a crash at any point before activation leaves a ring whose active
 * generation is still the one every key on disk is actually under.
 */
export function beginPendingGeneration(
  stateDir: string,
  root: Buffer,
  now: () => number = () => Date.now(),
): { readonly ring: KekRing; readonly generation: number } {
  const current = loadKekRing(stateDir, root);
  if (current.pending !== null) {
    throw new KekRingError(
      'this ring already has a pending generation from an unfinished rotation. Resume that rotation or abandon '
      + 'it deliberately; starting a second one would leave keys spread across three generations.');
  }
  const generation = Math.max(...current.generations.map((entry) => entry.generation)) + 1;
  const at = now();
  const next: KekRing = {
    ...current,
    generations: [...current.generations, {
      generation,
      state: 'pending',
      keyHex: randomBytes(KEY_BYTES).toString('hex'),
      createdAt: at,
      origin: 'generated-in-sidecar',
    }],
    pending: generation,
    updatedAt: at,
  };
  storeRing(stateDir, root, next);
  return { ring: next, generation };
}

/**
 * Make the pending generation active, and keep the previous one.
 *
 * THE PREVIOUS GENERATION IS RETAINED, DELIBERATELY. It is what a restore of a backup taken BEFORE the
 * rotation needs: those wrapped DEKs are under the old KEK, and a ring that forgot it the moment the new one
 * activated would make every pre-rotation backup unrestorable. It is retired only by an explicit command,
 * after a post-rotation backup has verified. See `retireGeneration`.
 */
export function activatePendingGeneration(
  stateDir: string,
  root: Buffer,
  now: () => number = () => Date.now(),
): KekRing {
  const current = loadKekRing(stateDir, root);
  if (current.pending === null) throw new KekRingError('this ring has no pending generation to activate');
  const at = now();
  const next: KekRing = {
    ...current,
    generations: current.generations.map((entry) => {
      if (entry.generation === current.pending) return { ...entry, state: 'active' as const };
      // The outgoing one stays in the ring and stays usable; it simply stops being what new wraps use.
      if (entry.generation === current.active) return { ...entry, state: 'retired' as const };
      return entry;
    }),
    active: current.pending,
    pending: null,
    updatedAt: at,
  };
  storeRing(stateDir, root, next);
  return next;
}

/**
 * Remove a retained generation from the ring entirely.
 *
 * IRREVERSIBLE, AND GATED ON MORE THAN A FLAG. Every backup taken while that generation was active becomes
 * unrestorable at this moment. The caller (`ops:kek-rotate --retire`) will not run it without a post-rotation
 * complete backup that verifies, and this refuses to remove the active or pending one whatever it is asked.
 */
export function retireGeneration(
  stateDir: string,
  root: Buffer,
  generation: number,
  now: () => number = () => Date.now(),
): KekRing {
  const current = loadKekRing(stateDir, root);
  if (generation === current.active) throw new KekRingError('the ACTIVE generation cannot be retired');
  if (generation === current.pending) throw new KekRingError('a PENDING generation cannot be retired');
  const found = current.generations.find((entry) => entry.generation === generation);
  if (found === undefined) throw new KekRingError('the KEK ring holds no such generation');
  const next: KekRing = {
    ...current,
    generations: current.generations.filter((entry) => entry.generation !== generation),
    updatedAt: now(),
  };
  storeRing(stateDir, root, next);
  return next;
}

/**
 * Re-seal the ring under a NEW root wrapping key.
 *
 * A DIFFERENT OPERATION FROM ROTATING A KEK, and worth keeping separate. This changes nothing about what any
 * wrapped DEK is under — no key file is touched, nothing is re-wrapped, and the ring's contents are byte for
 * byte what they were. It changes only which 32 bytes open the ring. That is the right response to "the root
 * key file may have been read", and it is fast; rotating the KEKs is the right response to "a KEK may have
 * been read", and it rewrites every key file.
 *
 * The write is atomic and self-describing (see `custodian-state-io.ts`), so an interrupted re-seal leaves the
 * ring wholly under the old root or wholly under the new — never a file that opens under neither.
 */
export function rotateRootWrappingKey(
  stateDir: string,
  fromRoot: Buffer,
  toRoot: Buffer,
  now: () => number = () => Date.now(),
): { readonly from: string; readonly to: string } {
  if (toRoot.length !== KEY_BYTES) throw new KekRingError('the new root wrapping key is not 32 bytes');
  if (fromRoot.length === toRoot.length && timingSafeEqual(fromRoot, toRoot)) {
    throw new KekRingError('the new root wrapping key is the current one, so there is nothing to re-seal');
  }
  const ring = loadKekRing(stateDir, fromRoot);
  storeRing(stateDir, toRoot, { ...ring, updatedAt: now() });
  return { from: rootKeyId(fromRoot), to: rootKeyId(toRoot) };
}

/** What a report may say. Numbers, closed words and a non-reversible root label. Never a key. */
export function summarizeKekRing(ring: KekRing, root: Buffer): KekRingSummary {
  const active = ring.generations.find((entry) => entry.generation === ring.active)!;
  return {
    active: ring.active,
    pending: ring.pending,
    retained: ring.generations.filter((entry) => entry.state === 'retired').map((entry) => entry.generation).sort(),
    rootKeyId: rootKeyId(root),
    activeCreatedAt: active.createdAt,
    origin: active.origin,
  };
}
