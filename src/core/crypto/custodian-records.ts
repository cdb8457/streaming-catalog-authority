import {
  CustodianStateError,
  readStateFileBytes,
  stateFileExists,
  writeStateFileBytes,
} from './custodian-state-io.js';

// Phase 285 — the custodian's OWN records, read the way its ring is read.
//
// -----------------------------------------------------------------------------------------------------
// WHAT WAS STILL `existsSync` + `readFileSync` + `JSON.parse` + `as T`, AND WHAT EACH ONE COST.
// -----------------------------------------------------------------------------------------------------
//
// Phase 281 hardened the KEK ring's file and left the four record kinds beside it — the wrapped key files,
// the operation records, the tombstones and the destroy journal — being read by a three-line helper that
// existed before any of this was thought about. Every problem the ring's reader exists to prevent was still
// live one directory over, and these files are the ones that decide whether an item can be read at all:
//
//   1. `existsSync` FOLLOWS A LINK AND ANSWERS `false` FOR A PERMISSION REFUSAL. Both mattered. A tombstone
//      replaced by a symlink was "there" and read the key as destroyed; a keystore this process could not
//      read answered `not_found`, and a fail-closed reader cannot tell `not_found` from a correct erasure. An
//      installation whose keystore had become unreadable reported itself as an installation with no keys.
//   2. `readFileSync` FOLLOWS A LINK TOO, AND IS UNBOUNDED. A `keys/<hash>.json` pointed somewhere else was
//      read as a key file, and a file somebody grew was this process allocating whatever was on disk.
//   3. `JSON.parse(...) as KeyFile` IS NOT A CHECK. It is a cast. `{}` became a key file whose `state` was
//      `undefined` (reported as `key not active (undefined)`) and whose `wrappedHex` was `undefined` (a
//      TypeError from inside the unwrap). `{}` in the destroy journal was worse: the recovery that runs in
//      the CONSTRUCTOR hashed `undefined` into a filename and threw a TypeError, so one unreadable journal
//      file meant the custodian could not be constructed at all and nothing said why.
//   4. NOTHING SAID WHICH VERSION WROTE THE FILE, so a future change of shape would be read by this build as
//      far as the fields that happened to match.
//
// So every record goes through here: bounded, no-follow, proved-regular-file bytes (the same reader the ring
// uses), then a CLOSED schema per record kind — every field checked, every unknown field refused, every
// operation-specific rule enforced — and `null` returned ONLY for a name that is genuinely not there.
//
// -----------------------------------------------------------------------------------------------------
// WHY THESE ARE NOT WRAPPED IN THE RING'S SELF-DESCRIBING ENVELOPE, WHICH IS A DELIBERATE CHOICE.
// -----------------------------------------------------------------------------------------------------
//
// `writeStateDocument` wraps a document in `{doc, bytes, digest}` so a partial write cannot parse as a whole
// one. The ring is one file written by one command; the keystore is thousands of files that EXISTING
// installations already hold, that published backup sets already contain, and that this build must keep
// reading. Changing their shape would make every set taken before today unreadable by the code that reads
// them, which is a far larger risk than the one the envelope closes.
//
// The envelope's guarantee is obtained here another way, and this is the whole argument:
//
//   * A PARTIAL WRITE CANNOT HAPPEN. Records are written through `writeStateFileBytes` — a temp file opened
//     O_EXCL at 0600, written in a LOOP that handles a short `write(2)` return, fsync'd, renamed, and the
//     directory fsync'd. What lands at the name is the whole document or the previous one.
//   * A TRUNCATION CANNOT PARSE. Every record is a JSON object, so a prefix of one is valid JSON only if it
//     closes its own brace — which a prefix of an object never does. A truncated record is a parse refusal,
//     not a shorter record.
//   * A CHANGED FIELD IS STILL CAUGHT WHERE IT MATTERS. The wrapped DEK is AEAD-authenticated under the KEK
//     with the key id as AAD, so the one field an attacker would want to alter is already covered by a tag
//     this file could not forge.
//
// A `version` is written from now on and validated exactly, so the NEXT shape change is a refusal rather
// than a partial read. A record without one is a record written before this phase, and is accepted as
// exactly that and nothing more.

/** The version this build writes. A record carrying any other value is refused, not adapted. */
export const CUSTODIAN_RECORD_VERSION = 1;

/**
 * How large any one custodian record may be.
 *
 * A wrapped key file is a few hundred bytes: a 32-byte DEK wraps to 120 hex characters, and the rest is
 * four identifiers and two numbers. This is generous by an order of magnitude and still refuses a file
 * somebody grew before a byte of it is allocated.
 */
export const MAX_CUSTODIAN_RECORD_BYTES = 8 * 1024;

/** How long an identifier this custodian will store may be. Ids become filenames (hashed) and AAD. */
export const MAX_CUSTODIAN_ID_LENGTH = 512;

/** How long a wrapped DEK may be, as hex. 12-byte nonce + ciphertext + 16-byte tag, with room to spare. */
export const MAX_WRAPPED_HEX_LENGTH = 4096;

/** The shortest wrapped value that could possibly be one: a nonce and a tag, with nothing between them. */
export const MIN_WRAPPED_HEX_LENGTH = (12 + 16) * 2;

/**
 * A record this custodian will not act on.
 *
 * IT NAMES THE RULE AND THE RECORD KIND, AND NOTHING ELSE. No path, no field value, no fragment of a wrapped
 * DEK: these files hold key material, and an error carrying part of one would be the disclosure the whole
 * design exists to prevent.
 */
export class CustodianRecordError extends Error {
  readonly code = 'CUSTODIAN_RECORD_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'CustodianRecordError';
  }
}

/** A wrapped DEK, as it is stored. `kekVersion` absent means a file written before generations existed. */
export interface KeyRecord {
  readonly version?: number;
  readonly keyId: string;
  readonly itemId: string;
  readonly epoch: number;
  readonly operationId: string;
  readonly state: 'provisional' | 'active';
  readonly wrappedHex: string;
  readonly createdAt: number;
  readonly kekVersion?: number;
}

/** What one operation id did. The fields depend on the KIND, and are checked against it. */
export type OpRecord =
  | {
      readonly version?: number;
      readonly operationId: string;
      readonly kind: 'provision';
      readonly keyId: string;
      readonly itemId: string;
      readonly epoch: number;
    }
  | {
      readonly version?: number;
      readonly operationId: string;
      readonly kind: 'destroy';
      readonly keyId: string;
    };

/** A destruction that completed. The receipt is derived from this, so every field is attestation input. */
export interface TombstoneRecord {
  readonly version?: number;
  readonly keyId: string;
  readonly receiptId: string;
  readonly destroyedAt: string;
}

/** A destruction that was INTENDED. The crash fence: written before the key file is touched. */
export interface JournalRecord {
  readonly version?: number;
  readonly keyId: string;
  readonly receiptId: string;
  readonly destroyedAt: string;
}

/** What a record kind is called in a refusal. Never a path — the kind is the whole diagnostic. */
export type CustodianRecordKind = 'key record' | 'operation record' | 'tombstone' | 'destroy journal entry';

/**
 * `refuse` RETURNS the error rather than throwing it, and every caller writes `throw refuse(...)`.
 *
 * A callback that throws reads slightly better and hides the control flow from the type checker, which then
 * cannot see that the code after it is unreachable. In a validator that is exactly the place to be explicit:
 * the whole point is that nothing past a failed rule is believed.
 */
type Refuse = (rule: string) => CustodianRecordError;

interface RecordSchema<T> {
  readonly kind: CustodianRecordKind;
  /** Turn a parsed object into the record, or throw. Every field, and no field it does not declare. */
  readonly check: (doc: Record<string, unknown>, refuse: Refuse) => T;
}

// -----------------------------------------------------------------------------------------------------------
// The field rules, shared by every schema
// -----------------------------------------------------------------------------------------------------------

/**
 * An identifier this custodian will store.
 *
 * NO CONTROL CHARACTER, INCLUDING A NEWLINE. An attestation is an HMAC over newline-separated fields, so an
 * id carrying a newline is an id that can be chosen to make one attestation line look like another. The
 * writer already refused a newline at the point of attestation; refusing it at the point of STORAGE means the
 * check cannot be reached with a value that was written before it.
 */
function isStoredId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CUSTODIAN_ID_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** A whole, non-negative number a schema can hold. Not a float, not negative, not beyond exact arithmetic. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/** A wrapped DEK: lowercase hex, an even number of digits, long enough to hold a nonce and a tag. */
function isWrappedHex(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= MIN_WRAPPED_HEX_LENGTH
    && value.length <= MAX_WRAPPED_HEX_LENGTH
    && value.length % 2 === 0
    && /^[0-9a-f]+$/.test(value);
}

/**
 * The version field, checked EXACTLY.
 *
 * Absent is the one legacy shape this build accepts, and it means "written before Phase 285". Any other value
 * — a later version, a string, a float — is a record this build does not understand, and reading the fields
 * that happen to match would be exactly the half-trust this module exists to remove.
 */
function checkVersion(doc: Record<string, unknown>, refuse: Refuse): void {
  if (!('version' in doc)) return;
  if (doc.version !== CUSTODIAN_RECORD_VERSION) throw refuse('carries a version this build does not write or read');
}

/** No key the schema does not declare. A record with one was written by something that is not this build. */
function closed(doc: Record<string, unknown>, allowed: readonly string[], refuse: Refuse): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) throw refuse('carries a field this build does not write');
  }
}

// -----------------------------------------------------------------------------------------------------------
// The four schemas
// -----------------------------------------------------------------------------------------------------------

export const KEY_RECORD_SCHEMA: RecordSchema<KeyRecord> = {
  kind: 'key record',
  check: (doc, refuse) => {
    closed(doc, ['version', 'keyId', 'itemId', 'epoch', 'operationId', 'state', 'wrappedHex', 'createdAt',
      'kekVersion'], refuse);
    checkVersion(doc, refuse);
    if (!isStoredId(doc.keyId) || !isStoredId(doc.itemId) || !isStoredId(doc.operationId)) {
      throw refuse('names an identifier this custodian would not have written');
    }
    if (!isCount(doc.epoch) || !isCount(doc.createdAt)) throw refuse('carries a number that is not a whole count');
    if (doc.state !== 'provisional' && doc.state !== 'active') throw refuse('is in no state this build defines');
    if (!isWrappedHex(doc.wrappedHex)) {
      throw refuse('does not hold a wrapped value of the shape this build writes');
    }
    if ('kekVersion' in doc && !isCount(doc.kekVersion)) throw refuse('names a KEK generation that is not a number');
    return doc as unknown as KeyRecord;
  },
};

export const OP_RECORD_SCHEMA: RecordSchema<OpRecord> = {
  kind: 'operation record',
  check: (doc, refuse) => {
    checkVersion(doc, refuse);
    if (!isStoredId(doc.operationId) || !isStoredId(doc.keyId)) {
      throw refuse('names an identifier this custodian would not have written');
    }
    // OPERATION-SPECIFIC, NOT A UNION OF EVERY FIELD. A destroy record carrying an item id and an epoch is a
    // provision record wearing the wrong kind, and the reader that believed it would compare a provision's
    // inputs against fields nothing had written.
    if (doc.kind === 'provision') {
      closed(doc, ['version', 'operationId', 'kind', 'keyId', 'itemId', 'epoch'], refuse);
      if (!isStoredId(doc.itemId)) throw refuse('names an identifier this custodian would not have written');
      if (!isCount(doc.epoch)) throw refuse('carries a number that is not a whole count');
    } else if (doc.kind === 'destroy') {
      closed(doc, ['version', 'operationId', 'kind', 'keyId'], refuse);
    } else {
      throw refuse('names an operation kind this build does not perform');
    }
    return doc as unknown as OpRecord;
  },
};

export const TOMBSTONE_SCHEMA: RecordSchema<TombstoneRecord> = {
  kind: 'tombstone',
  check: (doc, refuse) => {
    closed(doc, ['version', 'keyId', 'receiptId', 'destroyedAt'], refuse);
    checkVersion(doc, refuse);
    if (!isStoredId(doc.keyId) || !isStoredId(doc.receiptId) || !isStoredId(doc.destroyedAt)) {
      throw refuse('names an identifier this custodian would not have written');
    }
    return doc as unknown as TombstoneRecord;
  },
};

export const JOURNAL_SCHEMA: RecordSchema<JournalRecord> = {
  kind: 'destroy journal entry',
  check: (doc, refuse) => {
    closed(doc, ['version', 'keyId', 'receiptId', 'destroyedAt'], refuse);
    checkVersion(doc, refuse);
    if (!isStoredId(doc.keyId) || !isStoredId(doc.receiptId) || !isStoredId(doc.destroyedAt)) {
      throw refuse('names an identifier this custodian would not have written');
    }
    return doc as unknown as JournalRecord;
  },
};

// -----------------------------------------------------------------------------------------------------------
// Reading and writing one record
// -----------------------------------------------------------------------------------------------------------

/**
 * Read one record, or answer `null` because the name is genuinely not there.
 *
 * `null` MEANS ENOENT AND NOTHING ELSE. Every other outcome — a symbolic link, a directory or a device at that
 * name, a file larger than the bound, a file that changed size while it was read, bytes that are not JSON, a
 * document that is not the shape this build writes — is a refusal. This is the distinction the whole custodian
 * rests on: `not_found` is an answer about a key that was never provisioned, and a fail-closed reader treats
 * it as a correct erasure. Anything else answering `not_found` turns an unreadable keystore into an empty one.
 */
export function readCustodianRecord<T>(path: string, schema: RecordSchema<T>): T | null {
  let bytes: Buffer;
  try {
    bytes = readStateFileBytes(path, MAX_CUSTODIAN_RECORD_BYTES);
  } catch (err) {
    if (err instanceof CustodianStateError && err.message.endsWith('is not there')) return null;
    throw new CustodianRecordError(err instanceof CustodianStateError
      ? `a custodian ${schema.kind} could not be read: ${describeStateRefusal(err.message)}`
      : `a custodian ${schema.kind} could not be read`);
  }
  return parseCustodianRecord(bytes, schema);
}

/** The record a set of bytes holds, or a refusal. Split out so a caller holding bytes need not re-open. */
export function parseCustodianRecord<T>(bytes: Buffer, schema: RecordSchema<T>): T {
  const refuse: Refuse = (rule: string) => new CustodianRecordError(
    `a custodian ${schema.kind} ${rule}. Refused: a record this build cannot state in full is not one it `
    + 'will act on.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw refuse('is not a document this build wrote');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw refuse('is not a document this build wrote');
  }
  return schema.check(parsed as Record<string, unknown>, refuse);
}

/**
 * Write one record: the whole document or the previous one, and never a partial.
 *
 * IT IS VALIDATED ON THE WAY OUT. Not because the caller is untrusted, but because a record this build would
 * refuse to READ must never be one it wrote — a keystore that can only be repaired by loosening the reader is
 * the worst outcome available here, and the cheapest moment to prevent it is before the bytes land.
 */
export function writeCustodianRecord<T>(path: string, schema: RecordSchema<T>, record: T): void {
  // THE VERSION IS STAMPED HERE, NOT BY THE CALLER. Every mutation on the custodian is a read-modify-write of
  // an existing record — `{...kf, state: 'active'}` — so a record read from a build before this phase carried
  // its versionless shape straight back to disk, and a keystore would never converge. The build that wrote
  // the bytes is the version of the bytes, and this is the one place that knows both.
  const stamped = { ...(record as object), version: CUSTODIAN_RECORD_VERSION } as T;
  const body = Buffer.from(JSON.stringify(stamped), 'utf8');
  if (body.byteLength > MAX_CUSTODIAN_RECORD_BYTES) {
    throw new CustodianRecordError(`a custodian ${schema.kind} is larger than this build will store`);
  }
  parseCustodianRecord(body, schema);
  writeStateFileBytes(path, body);
}

/**
 * Is a record THERE, without reading it?
 *
 * ONLY "IT IS NOT THERE" IS `false` — the rule `stateFileExists` already enforces. A link, a special file or a
 * permission refusal is something at that name, and answering `false` for one of those is how a tombstone
 * becomes invisible and a destroyed key reads as live.
 */
export function custodianRecordExists(path: string): boolean {
  return stateFileExists(path);
}

/** Restate the state reader's refusal without repeating anything host-specific. It names rules only. */
function describeStateRefusal(message: string): string {
  if (message.includes('symbolic link')) return 'it is a symbolic link, and this custodian will not follow one';
  if (message.includes('not a regular file')) return 'it is not a regular file';
  if (message.includes('larger than')) return 'it is larger than this custodian will read';
  if (message.includes('changed size')) return 'it changed size while it was being read';
  return 'it could not be opened';
}
