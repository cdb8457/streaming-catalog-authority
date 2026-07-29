import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, type Dirent } from 'node:fs';
import path from 'node:path';
import {
  CUSTODIAN_WRITER_LOCK,
  CustodianStateError,
  STATE_DIR_MODE,
  acquireStateLock,
  fsyncDirectoryBestEffort,
  stateDirectoryFacts,
  stateDirectoryIdentity,
  type StateDirectoryIdentity,
} from './custodian-state-io.js';
import {
  CustodianRecordError,
  JOURNAL_SCHEMA,
  assertRecordAddress,
  custodianRecordName,
  KEY_RECORD_SCHEMA,
  OP_RECORD_SCHEMA,
  TOMBSTONE_SCHEMA,
  custodianRecordExists,
  readCustodianRecord,
  writeCustodianRecord,
  type JournalRecord,
  type KeyRecord,
  type OpRecord,
  type TombstoneRecord,
} from './custodian-records.js';
import type { DestructionReceipt, KeyCustodian, KeyStatus, ProvisionResult, StaleProvisioning } from './custodian.js';

/**
 * Filesystem-backed REFERENCE custodian harness.
 *
 * Hardened: ids are hashed into filenames with resolved-path containment (no traversal);
 * DEKs are stored WRAPPED under a KEK (never raw); writes are atomic (temp -> fsync ->
 * rename -> fsync(dir), mode 0600); destroy is crash-recoverable via a journal and refuses
 * an unknown key; the completion secret and KEK are supplied explicitly (no importable default).
 *
 * Irreversibility, stated precisely: destroy replaces the wrapped-DEK file with a zeroized
 * blob (atomic rename) and then unlinks it. The atomic rename does NOT overwrite the original
 * file's inode/blocks in place — it swaps in a new inode and drops the old one, whose blocks
 * may linger (journaling / copy-on-write / SSD wear-levelling can retain them) until reused.
 * So this is NOT a guaranteed physical scrub of the DEK bytes. The erasure guarantee does not
 * rest on a physical overwrite: it rests on the DEK being stored only WRAPPED under the KEK,
 * the wrapped file being removed from the live keystore, and the keystore + KEK being EXCLUDED
 * from every main-DB backup (Stage 3b). A surviving wrapped-DEK block is useless without the
 * KEK, which a destroy of the lineage never reproduces.
 *
 * It is still a REFERENCE harness, NOT the production adapter: it runs in-process (so the
 * trust boundary is not enforced — a real deployment runs the custodian as a separate
 * service / managed KMS holding the secret+KEK outside the app), and FS-level deletion is only
 * best-effort physical irreversibility (see above). The design O4 production target is a
 * managed-KMS implementation of this same KeyCustodian interface, not this class.
 */

// THE FOUR RECORD SHAPES LIVE IN `custodian-records.ts` NOW, WITH THEIR SCHEMAS.
//
// They used to be four bare interfaces here and four `JSON.parse(...) as T` casts below — which is a type
// that describes what the code hopes a file holds, not a check on what it does. The shapes and the rules that
// enforce them are one thing, so they are in one place, and every read on this class goes through them.
type KeyFile = KeyRecord;
type Tombstone = TombstoneRecord;
type OpFile = OpRecord;
type Journal = JournalRecord;

export interface RewrapPlan {
  needsRewrap: number;
  alreadyCurrent: number;
  total: number;
}

// --- KEK wrap/unwrap + atomic IO (module-level so the static KEK rewrap reuses the EXACT format/AAD) ---
function wrapDek(kek: Buffer, dek: Buffer, keyId: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, nonce);
  c.setAAD(Buffer.from(keyId, 'utf8'));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('hex');
}
function unwrapDek(kek: Buffer, wrappedHex: string, keyId: string): Buffer {
  const b = Buffer.from(wrappedHex, 'hex');
  const nonce = b.subarray(0, 12);
  const tag = b.subarray(b.length - 16);
  const ct = b.subarray(12, b.length - 16);
  const d = createDecipheriv('aes-256-gcm', kek, nonce);
  d.setAAD(Buffer.from(keyId, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
/**
 * The one shape a wrapped key file's name has. The custodian hashes every id into exactly this.
 *
 * IT IS A RULE, NOT A FILTER. The walks below used to accept anything ending in `.json` and silently ignore
 * everything else — including a `.tmp` left by an interrupted write, which is precisely the state in which the
 * set of keys is not settled and a rewrap must not claim to have covered it.
 */
const KEYSTORE_FILE_NAME = /^[0-9a-f]{64}\.json$/;

/** How many key files a single rewrap or preflight will walk before refusing. */
const MAX_KEYSTORE_FILES = 500_000;

/**
 * A key file, written whole or not at all.
 *
 * THE DEFECT THIS CLOSES. This was `writeSync(fd, JSON.stringify(value))` and nothing else. `write(2)` may
 * write FEWER bytes than it was given — on a full filesystem, on a signal, on a share — and the return value
 * saying so was discarded. What landed was a truncated key file whose next read was a JSON parse error: safe,
 * but the wrong failure, because the write is what should have completed. `writeCustodianRecord` loops until
 * the whole body is written, fsyncs, renames and fsyncs the directory, so a key file is the complete new
 * document or the complete previous one.
 */
function writeKeyFile(p: string, record: KeyFile): void {
  writeCustodianRecord(p, KEY_RECORD_SCHEMA, record);
}

/**
 * Create one custodian directory if it is not there, and PROVE what is there is fit to hold key material.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHAT IS REFUSED, WHAT IS NOT, AND WHY THE LINE IS THERE AND NOT SOMEWHERE ELSE.
 * -----------------------------------------------------------------------------------------------------
 *
 * REFUSED, ALWAYS: a symbolic link, anything that is not a directory, and a directory this process cannot
 * open. Those are unambiguous — a keystore reached through a link is somebody else's keystore, and there is
 * no legitimate installation in which one of these names is a link.
 *
 * REFUSED ON POSIX: a directory belonging to ANOTHER USER, and one that is GROUP- OR WORLD-WRITABLE. Both are
 * live custody failures rather than untidiness: an account that can write into `keys/` can replace a wrapped
 * key file, and the address-binding above is what makes that a refusal rather than a substitution — but only
 * for a file it can already read. A directory somebody else can write is a keystore somebody else controls.
 *
 * NOT REFUSED, DELIBERATELY: group- or world-READABLE (`0755`, which is what `mkdir` under the default umask
 * produces). Two reasons, and this is the judgement call in this function. First, every installation made
 * before this build has exactly that, so refusing it would turn an upgrade into an outage for installations
 * whose keystore is otherwise perfectly sound — and a custodian that will not construct is an app that
 * reports every item as unreadable. Second, what is IN these directories is wrapped under a KEK that is not
 * in them, so readability is a weakening rather than a compromise. It is still worth fixing, and the thing
 * that fixes it is `ops:keystore-repair`, which reports what it found and repairs deliberately.
 *
 * NOTHING HERE RE-MODES AN EXISTING DIRECTORY. A create gets `0700`; a directory that is already there is
 * left exactly as it is and judged. Silently widening or narrowing an operator's permissions from inside a
 * constructor is how a tool destroys something nobody asked it to touch.
 */
function proveCustodianDirectory(dir: string, what: string): StateDirectoryIdentity {
  try {
    mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  } catch {
    // A create that fails is not the diagnostic; what is at that name is, and the interrogation below says so.
  }
  let facts;
  try {
    facts = stateDirectoryFacts(dir);
  } catch (err) {
    throw new Error(`the custodian ${what} directory is not one this build will use (${
      err instanceof CustodianStateError ? err.message : 'it could not be opened'}). Nothing was read or written.`);
  }
  if (facts.uid !== null) {
    const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
    const uid = typeof getuid === 'function' ? getuid.call(process) : null;
    if (uid !== null && facts.uid !== uid) {
      throw new Error(`the custodian ${what} directory belongs to another user. A custodian will not keep key `
        + 'material in a directory it does not own. Nothing was read or written.');
    }
  }
  if (facts.mode !== null && (facts.mode & 0o022) !== 0) {
    throw new Error(`the custodian ${what} directory is writable by somebody other than its owner, so any `
      + 'account on this host could add or replace a wrapped key in it. Refused before anything was read or '
      + 'written; nothing was changed, because changing an operator\'s permissions from here is not this '
      + 'command\'s business — see ops:keystore-repair.');
  }
  return { dev: facts.dev, ino: facts.ino };
}

/**
 * Is there a keystore directory here at all?
 *
 * `existsSync` FOLLOWED A LINK AND ANSWERED `false` FOR A DIRECTORY IT COULD NOT REACH. The first made a
 * symlinked `keys` look like a keystore; the second made an unreadable one look like an installation that has
 * never stored anything, which is the answer a rewrap would have reported as "0 files, nothing to do".
 */
function keystoreDirectoryExists(keysDir: string, what: string): boolean {
  try {
    stateDirectoryIdentity(keysDir);
    return true;
  } catch (err) {
    // GENUINELY ABSENT IS THE ONLY `false`. A link, a file, a permission refusal at that name is a keystore
    // this build will not walk — refused in the SAME words the walk itself uses, so an operator does not get
    // one sentence for a directory that cannot be identified before the lock and a different one after it.
    if (err instanceof CustodianStateError && err.message.endsWith('is not there')) return false;
    throw new Error(`${what}: keystore could not be read`);
  }
}

/** WHICH directory the walk is over, established on a descriptor without following a link. */
function keystoreIdentity(keysDir: string, what: string): StateDirectoryIdentity {
  try {
    return stateDirectoryIdentity(keysDir);
  } catch {
    throw new Error(`${what}: keystore could not be read`);
  }
}

/** The same directory the walk started in, or a refusal. A count over two directories is not a count. */
function assertKeystoreUnmoved(keysDir: string, before: StateDirectoryIdentity, what: string): void {
  const after = keystoreIdentity(keysDir, what);
  if (after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error(`${what}: the keystore directory was replaced while it was being read`);
  }
}

/**
 * Every wrapped key file in a keystore, as a STATED set.
 *
 * AN UNEXPECTED ENTRY IS A REFUSAL, NOT SOMETHING SKIPPED. The walks used to be `readdirSync(...)` filtered
 * to names ending in `.json`, which quietly ignored everything else — including the `.tmp` a crashed write
 * leaves behind, which is exactly the state in which the set is not settled. It also passed a DIRECTORY or a
 * device named `<hash>.json` straight to a reader as though it were a key file. Both are closed here: the
 * name must be one this custodian writes and the entry must be a regular file, and anything else stops the
 * walk rather than shortening it.
 */
function listKeystoreFiles(keysDir: string, what = 'keystore'): string[] {
  return listRecordFiles(keysDir, what);
}

/**
 * Every record file in one custodian directory, as a STATED set.
 *
 * The same rule for the journal as for the keystore, because the journal decides what gets destroyed: the
 * name must be one this custodian writes, the entry must be a regular file, and the count is bounded. An
 * unexpected entry stops the walk instead of being skipped — a directory holding one is a directory whose
 * contents nobody can state, and "recover from the ones I recognised" is not a recovery.
 */
function listRecordFiles(dir: string, what: string, noun = 'wrapped key file'): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error(`${what}: keystore could not be read`);
  }
  if (entries.length > MAX_KEYSTORE_FILES) {
    throw new Error(`${what}: this directory holds more entries than this build will walk`);
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!KEYSTORE_FILE_NAME.test(entry.name)) {
      throw new Error(`${what}: this keystore holds an entry that is not a ${noun} this custodian `
        + 'wrote — a leftover from an interrupted write, or something put there by hand. The set of records '
        + 'this operation covers cannot be stated while it is there.');
    }
    if (!entry.isFile()) {
      throw new Error(`${what}: this keystore holds an entry that is not a regular file`);
    }
    names.push(entry.name);
  }
  return names;
}

/**
 * One key file, through the bounded no-follow boundary, its closed schema, AND its own name.
 *
 * A WALK READS BY NAME, SO A WALK HAS TO CHECK THE NAME. `entry` came from a listing rather than from an id,
 * which is the one place where nothing else in this class would ever compare the two: a key file copied onto
 * another key file's name is well formed, unwraps under its own `keyId` as AAD, and would have been rewrapped
 * and counted as the key whose name it was wearing.
 */
function readKeystoreFile(p: string, what: string, entry?: string): KeyFile {
  let record: KeyFile | null;
  try {
    record = readCustodianRecord(p, KEY_RECORD_SCHEMA);
  } catch (err) {
    // THE RULE, NEVER THE PATH. The record reader's refusals name what was wrong with the record and nothing
    // about where it lives; this keeps the operation's own prefix so an operator knows which command refused.
    throw new Error(`${what}: a key file could not be read (${err instanceof CustodianRecordError
      ? err.message : 'it is not a record this build wrote'})`);
  }
  // LISTED AND THEN GONE IS NOT AN EMPTY KEY FILE. Something removed it between the listing and this read,
  // which means the set this operation is covering is moving underneath it.
  if (record === null) throw new Error(`${what}: a key file was removed while the keystore was being read`);
  if (entry !== undefined) {
    try {
      assertRecordAddress(custodianRecordName(record.keyId), entry, 'key record');
    } catch (err) {
      throw new Error(`${what}: ${err instanceof CustodianRecordError ? err.message
        : 'a key file names a different key from the one it is filed under'}`);
    }
  }
  return record;
}

export class FileCustodian implements KeyCustodian {
  private readonly root: string;
  private readonly keysDir: string;
  private readonly tombDir: string;
  private readonly opsDir: string;
  private readonly journalDir: string;
  /**
   * WHICH directories the two WALKS read from, as they were when this custodian was built.
   *
   * A walk that lists a directory trusts the NAME twice — once when it lists and once for every file it opens
   * under it. Holding the identity turns that into one checkable claim: the directory this listing came from
   * is the directory this custodian proved at construction, and it did not become another one part way
   * through the walk.
   *
   * ONLY THE TWO THAT ARE WALKED ARE KEPT. All five names are proved at construction, but `ops/` and
   * `tombstones/` are only ever reached by hashing an id into a name — there is no listing of them to bracket,
   * so an identity held for them would be a field nothing compares, which reads as a guarantee that is not
   * enforced. The per-file no-follow open is what protects those, and the address binding is what makes the
   * file at the name the file for the name.
   */
  private readonly keysIdentity: StateDirectoryIdentity;
  private readonly journalIdentity: StateDirectoryIdentity;
  private readonly completionSecret: string;
  private readonly kek: Buffer;
  private readonly clock: () => number;

  /**
   * KEKs this custodian will UNWRAP under but never wrap under.
   *
   * PHASE 283, AND THE REASON A ROTATION IS SURVIVABLE. A rotation rewraps every key file onto a pending
   * generation and only afterwards moves the ring's active pointer. Between those two moments the key files
   * are under a generation the ring does not yet call active — so a sidecar that restarted there, holding only
   * the active KEK, would fail to unwrap everything. Every item would read as unreadable, which is
   * indistinguishable from a correct erasure, and nothing would say why.
   *
   * So the custodian is given every generation the ring retains and tries them in turn. GCM authentication
   * makes each attempt decisive — a wrong KEK does not produce wrong plaintext, it produces a tag failure —
   * so this is a lookup, not a guess. New wraps still use `kek` and only `kek`.
   */
  private readonly decryptOnlyKeks: readonly Buffer[];

  constructor(
    rootDir: string,
    completionSecret: string,
    kek: Buffer,
    clock: () => number = () => Date.now(),
    decryptOnlyKeks: readonly Buffer[] = [],
  ) {
    if (!completionSecret) throw new Error('completionSecret is required');
    if (kek.length !== 32) throw new Error('KEK must be 32 bytes');
    if (decryptOnlyKeks.some((extra) => extra.length !== 32)) throw new Error('every retained KEK must be 32 bytes');
    if (!rootDir) throw new Error('rootDir is required');
    this.decryptOnlyKeks = decryptOnlyKeks.map((extra) => Buffer.from(extra));
    this.root = path.resolve(rootDir);
    this.keysDir = path.join(this.root, 'keys');
    this.tombDir = path.join(this.root, 'tombstones');
    this.opsDir = path.join(this.root, 'ops');
    this.journalDir = path.join(this.root, 'journal');
    // ---- THE FIVE DIRECTORIES ARE PROVED, NOT ASSUMED ----------------------------------------------------
    //
    // THE HOLE THIS CLOSES. `mkdirSync(d, { recursive: true })` establishes NOTHING about a name that already
    // exists: on EEXIST it returns happily, so `<root>/keys` being a symbolic link to somebody else's
    // directory was a keystore this class read every key out of and wrote every key into, with the no-follow
    // rules on the FILES intact and useless — the boundary escaped through the parent. The static rewrap had
    // been given this check; the class that actually holds the keys had not.
    //
    // Each name is now opened without following a link, proved to be a directory ON THE DESCRIPTOR, and its
    // identity remembered so the walks below can prove they are still reading the same directories.
    proveCustodianDirectory(this.root, 'state');
    proveCustodianDirectory(this.tombDir, 'tombstone');
    proveCustodianDirectory(this.opsDir, 'operation');
    this.keysIdentity = proveCustodianDirectory(this.keysDir, 'keystore');
    this.journalIdentity = proveCustodianDirectory(this.journalDir, 'destroy journal');
    this.completionSecret = completionSecret;
    this.kek = kek;
    this.clock = clock;
    this.recover(); // finish any destroy interrupted by a crash
  }

  // --- the writer lock ------------------------------------------------------
  /**
   * ONE WRITER AT A TIME OVER ONE KEYSTORE — AND THE SAME LOCK THE KEY OPERATIONS TAKE.
   *
   * -----------------------------------------------------------------------------------------------------
   * WHY THIS HAD TO EXIST HERE AND NOT ONLY IN `kek-rotation.ts`.
   * -----------------------------------------------------------------------------------------------------
   *
   * The migration and the rotation both reason about the SET of wrapped keys: "every key in this keystore
   * opens under the key being adopted", "every key was rewrapped onto the new generation". Both took a lock
   * of their own and neither excluded THIS class, which is what actually writes key files. So a provision or
   * a destroy landing during either one changed the set the proof had been computed over, and the proof went
   * on describing a keystore that no longer existed. Recomputing the set afterwards narrows that window and
   * cannot close it: there is always a moment after the last check.
   *
   * The only thing that closes it is the writers taking the same lock, so they do. Every mutating entry point
   * on this class acquires `CUSTODIAN_WRITER_LOCK` in the state directory, and every key operation that
   * reasons about the set holds it for the whole of its transaction. A second writer is REFUSED, not
   * interleaved — two writers over one keystore is how a provision is silently discarded.
   *
   * NO NESTING, AND THEREFORE NO DEADLOCK. Each public mutator takes the lock and calls an unlocked core; the
   * cores call other cores and never a public mutator. The read-only entry points (`get`, `status`,
   * `listStaleProvisioning`, `planRewrapKeystore`) take nothing — `planRewrapKeystore` deliberately so,
   * because it is run against BACKUP SETS, and creating a lock directory inside a verified set would change
   * the very bytes its manifest is a digest of.
   *
   * These bodies are synchronous from end to end even where the method is declared `async`, so the lock is
   * held across no `await` and concurrent callers in one process serialise rather than collide.
   */
  private withWriteLock<T>(fn: () => T): T {
    const lock = acquireStateLock(this.root, CUSTODIAN_WRITER_LOCK);
    try {
      return fn();
    } finally {
      lock.release();
    }
  }

  private static withWriteLock<T>(rootDir: string, fn: () => T): T {
    const lock = acquireStateLock(path.resolve(rootDir), CUSTODIAN_WRITER_LOCK);
    try {
      return fn();
    } finally {
      lock.release();
    }
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

  // --- record IO ------------------------------------------------------------
  //
  // ONE READER PER RECORD KIND, EACH WITH ITS OWN CLOSED SCHEMA. What was here was
  // `if (!existsSync(p)) return null; return JSON.parse(readFileSync(p,'utf8')) as T` — a follow-the-link
  // existence check, an unbounded follow-the-link read, and a cast. Every one of the four kinds is now read
  // through the same bounded, no-follow, regular-file boundary the KEK ring uses, and `null` comes back only
  // for a name that is genuinely not there.
  //
  // AND EACH ONE IS BOUND TO THE NAME IT WAS READ UNDER. A schema says a record is well formed; it cannot say
  // it is the record that was asked for, because the id was used to build the path and then discarded. A file
  // COPIED from one valid name to another passed every check that existed, and the caller then believed the
  // id inside it — which is somebody else's key. See `assertRecordAddress`.
  private readKeyFile(keyId: string): KeyFile | null {
    const record = readCustodianRecord(this.keyPath(keyId), KEY_RECORD_SCHEMA);
    if (record !== null) assertRecordAddress(record.keyId, keyId, 'key record');
    return record;
  }
  private readOp(operationId: string): OpFile | null {
    const record = readCustodianRecord(this.opPath(operationId), OP_RECORD_SCHEMA);
    if (record !== null) assertRecordAddress(record.operationId, operationId, 'operation record');
    return record;
  }
  private readTombstone(keyId: string): Tombstone | null {
    const record = readCustodianRecord(this.tombPath(keyId), TOMBSTONE_SCHEMA);
    if (record !== null) assertRecordAddress(record.keyId, keyId, 'tombstone');
    return record;
  }

  /**
   * Is there a tombstone for this key?
   *
   * A REFUSAL IS NOT A `false`. A tombstone that is a link, a special file, or a document this build did not
   * write is not evidence that the key is live — it is a keystore nobody can state, and answering "no
   * tombstone" for one would resurrect a destroyed key. `readTombstone` throws on all of those; only a name
   * that is not there answers `null`.
   */
  private isDestroyed(keyId: string): boolean {
    return this.readTombstone(keyId) !== null;
  }

  /**
   * The directory this walk is reading is the directory this custodian proved when it was built.
   *
   * A LISTING IS A CLAIM ABOUT A NAME. Everything under it is opened without following a link, and none of
   * that says the name still refers to the directory whose contents this custodian is entitled to act on.
   * Comparing the identity turns "it was not a link when I looked" into "it is the same directory I proved".
   */
  private assertDirectoryUnmoved(dir: string, expected: StateDirectoryIdentity, what: string): void {
    let now: StateDirectoryIdentity;
    try {
      now = stateDirectoryIdentity(dir);
    } catch (err) {
      throw new Error(`the custodian ${what} directory could not be re-established (${
        err instanceof CustodianStateError ? err.message : 'it could not be opened'}).`);
    }
    if (now.dev !== expected.dev || now.ino !== expected.ino) {
      throw new Error(`the custodian ${what} directory was replaced after this custodian was built. Refused: `
        + 'what was listed from it is not what this custodian proved it would be reading.');
    }
  }

  private writeKeyRecord(keyId: string, record: KeyFile): void {
    writeCustodianRecord(this.keyPath(keyId), KEY_RECORD_SCHEMA, record);
  }
  private writeOp(record: OpFile): void {
    writeCustodianRecord(this.opPath(record.operationId), OP_RECORD_SCHEMA, record);
  }
  private writeTombstone(record: Tombstone): void {
    writeCustodianRecord(this.tombPath(record.keyId), TOMBSTONE_SCHEMA, record);
  }

  /**
   * fsync the containing directory so the rename — not just the file contents — survives a
   * crash. Without it, POSIX permits the renamed entry to be lost on power failure even though
   * the fsync'd file blocks are durable.
   *
   * Precise limitation: opening a directory for fsync is not portable. On Windows a directory
   * handle cannot be fsync'd this way (openSync throws EISDIR/EPERM), so this is a BEST-EFFORT
   * no-op there — a crash immediately after rename may still lose the directory entry on those
   * platforms. We swallow only the "directories are not fsync-able here" errors and let any
   * other error surface. Durable rename ordering is one more reason the production target (O4)
   * is a managed KMS, which does not depend on host filesystem directory-fsync semantics.
   */
  private fsyncDir(dir: string): void { fsyncDirectoryBestEffort(dir); }

  // --- KEK wrap/unwrap (DEKs are never stored raw) --------------------------
  /** New wraps use the ACTIVE key and only it. A retained generation is never written under. */
  private wrap(dek: Buffer, keyId: string): string { return wrapDek(this.kek, dek, keyId); }

  /**
   * Unwrap under the active KEK, or under a retained one.
   *
   * THE ACTIVE KEY IS TRIED FIRST, so the ordinary case costs one decrypt. A retained generation is tried
   * only when that fails, and the failure of ALL of them is the same fail-closed error the single-key version
   * produced — a key that no generation opens is not a key this custodian will pretend to have.
   */
  private unwrap(wrappedHex: string, keyId: string): Buffer {
    try {
      return unwrapDek(this.kek, wrappedHex, keyId);
    } catch (err) {
      for (const retained of this.decryptOnlyKeks) {
        try { return unwrapDek(retained, wrappedHex, keyId); } catch { /* the next generation, or the throw below */ }
      }
      throw err;
    }
  }

  private attest(keyId: string, receiptId: string, destroyedAt: string): string {
    if (/\n/.test(keyId) || /\n/.test(receiptId) || /\n/.test(destroyedAt)) throw new Error('attestation field contains a separator');
    return createHmac('sha256', this.completionSecret).update(`${keyId}\n${receiptId}\n${destroyedAt}`).digest('hex');
  }
  private receiptFor(t: Tombstone): DestructionReceipt {
    return { keyId: t.keyId, receiptId: t.receiptId, destroyedAt: t.destroyedAt, attestation: this.attest(t.keyId, t.receiptId, t.destroyedAt) };
  }

  // crash recovery: complete any destroy that journaled but didn't finish
  //
  // THE LOCK IS TAKEN ONLY WHERE THERE IS SOMETHING TO RECOVER. Construction is not a write, and a custodian
  // that took a writer lock merely to be constructed would refuse to exist while any key operation was
  // running. When there IS a journal entry, finishing it rewrites a key file and writes a tombstone — that is
  // a write, and it takes the lock like every other one.
  private recover(): void {
    // THE JOURNAL IS A CLOSED, BOUNDED SET OF NAMES, NOT A FILTER. `readdirSync(...).filter(endsWith('.json'))`
    // silently ignored everything else — a `.tmp` from an interrupted write, a directory, a device — so a
    // journal directory nobody could state was recovered from anyway. And the walk is bracketed by the
    // directory's identity, so a `journal` swapped for another directory mid-recovery is a refusal rather
    // than a destruction carried out against whatever appeared.
    this.assertDirectoryUnmoved(this.journalDir, this.journalIdentity, 'destroy journal');
    const journals = listRecordFiles(this.journalDir, 'the destroy journal', 'destroy journal entry');
    if (journals.length === 0) return;
    this.withWriteLock(() => {
      for (const f of journals) {
        // A JOURNAL ENTRY THAT CANNOT BE READ IS NOT AN ENTRY TO DELETE, AND NOT ONE TO IGNORE.
        //
        // THE DEFECT THIS CLOSES, WHICH WAS TWO DEFECTS. The old reader answered `null` for a file that was
        // not there AND for one that would not parse, and this loop removed whatever answered `null` — so an
        // unreadable destroy intent was silently thrown away, and the key it named stayed live with nothing
        // recording that it should not have. Worse, a file that DID parse but held the wrong shape (`{}` was
        // enough) reached `finishDestroy`, which hashed `undefined` into a filename and threw a TypeError
        // from inside the CONSTRUCTOR: one bad file and the custodian could not be built at all.
        //
        // Now the strict reader draws the line: genuinely absent is skipped (something removed it between the
        // listing and here), and anything else throws a refusal that names the record kind. A destroy intent
        // this build cannot read is a state for a human to look at, not one to guess at.
        const entry = readCustodianRecord(path.join(this.journalDir, f), JOURNAL_SCHEMA);
        if (entry === null) continue;
        // AND THE ENTRY IS FILED UNDER THE KEY IT NAMES. This is the readdressing case with the sharpest
        // consequence in the whole class: recovery ACTS on the id inside the record, so an entry copied onto
        // another key's journal name would have destroyed the key named inside it — a key nothing asked to
        // destroy, on the strength of a filename somebody chose. Checked BEFORE `finishDestroy` touches
        // anything, so a transplanted entry destroys neither key.
        assertRecordAddress(custodianRecordName(entry.keyId), f, 'destroy journal entry');
        this.finishDestroy(entry);
      }
    });
  }
  private finishDestroy(j: Journal): void {
    const kf = this.readKeyFile(j.keyId);
    if (kf !== null) {
      // Replace the live wrapped-DEK with a zeroized blob, then unlink. NOTE: the write swaps in a NEW inode
      // via rename — it does not scrub the original inode's blocks in place, so this is best-effort, not a
      // guaranteed physical overwrite (see the class doc). The real guarantee is wrapped-only storage +
      // keystore/KEK exclusion from backups.
      this.writeKeyRecord(j.keyId, { ...kf, wrappedHex: '0'.repeat(kf.wrappedHex.length) });
      rmSync(this.keyPath(j.keyId), { force: true });
      this.fsyncDir(this.keysDir); // make the unlink durable too
    }
    if (!this.isDestroyed(j.keyId)) {
      this.writeTombstone({ keyId: j.keyId, receiptId: j.receiptId, destroyedAt: j.destroyedAt });
    }
    rmSync(this.journalPath(j.keyId), { force: true });
  }

  // --- contract -------------------------------------------------------------
  async provision(operationId: string, itemId: string, epoch: number): Promise<ProvisionResult> {
    return this.withWriteLock(() => this.provisionUnlocked(operationId, itemId, epoch));
  }

  private provisionUnlocked(operationId: string, itemId: string, epoch: number): ProvisionResult {
    const prior = this.readOp(operationId);
    if (prior) {
      if (prior.kind !== 'provision' || prior.itemId !== itemId || prior.epoch !== epoch) throw new Error('operation_id reused with different inputs');
      if (this.isDestroyed(prior.keyId)) throw new Error('key is destroyed');
      const kf = this.readKeyFile(prior.keyId);
      if (!kf) throw new Error('key is destroyed');
      return { keyId: kf.keyId, dek: this.unwrap(kf.wrappedHex, kf.keyId) };
    }
    let keyId: string;
    // THE UNIQUENESS CHECK IS A FAIL-CLOSED ONE. `custodianRecordExists` answers `false` only for a name that
    // is not there, so a key file this process cannot read is never mistaken for a free name to write over.
    do {
      keyId = `key_${randomUUID()}`;
    } while (custodianRecordExists(this.keyPath(keyId)) || custodianRecordExists(this.tombPath(keyId)));
    const dek = randomBytes(32);
    this.writeKeyRecord(keyId, {
      keyId, itemId, epoch, operationId, state: 'provisional', wrappedHex: this.wrap(dek, keyId), createdAt: this.clock(), kekVersion: 0,
    });
    this.writeOp({ operationId, kind: 'provision', keyId, itemId, epoch });
    return { keyId, dek };
  }

  async commitProvision(operationId: string): Promise<void> {
    this.withWriteLock(() => this.commitProvisionUnlocked(operationId));
  }

  private commitProvisionUnlocked(operationId: string): void {
    const op = this.readOp(operationId);
    if (!op || op.kind !== 'provision') throw new Error('unknown provision operation');
    if (this.isDestroyed(op.keyId)) throw new Error('destroyed is terminal; cannot reactivate');
    const kf = this.readKeyFile(op.keyId);
    if (!kf) throw new Error('destroyed is terminal; cannot reactivate');
    if (kf.state !== 'active') this.writeKeyRecord(op.keyId, { ...kf, state: 'active' });
  }

  async get(keyId: string, epoch: number): Promise<Buffer> {
    if (this.isDestroyed(keyId)) throw new Error('key not active (destroyed)');
    const kf = this.readKeyFile(keyId);
    if (!kf) throw new Error('not_found');
    if (kf.state !== 'active') throw new Error(`key not active (${kf.state})`);
    if (kf.epoch !== epoch) throw new Error('epoch mismatch');
    return this.unwrap(kf.wrappedHex, kf.keyId);
  }

  async destroy(operationId: string, keyId: string): Promise<DestructionReceipt> {
    return this.withWriteLock(() => this.destroyUnlocked(operationId, keyId));
  }

  private destroyUnlocked(operationId: string, keyId: string): DestructionReceipt {
    const prior = this.readOp(operationId);
    if (prior) {
      if (prior.kind !== 'destroy' || prior.keyId !== keyId) throw new Error('operation_id reused with different inputs');
      // A REPLAYED DESTROY MUST FIND ITS TOMBSTONE. The `!` here used to be the whole check: an operation
      // record naming a destroy whose tombstone had gone produced a receipt over `undefined` fields.
      const recorded = this.readTombstone(keyId);
      if (recorded === null) {
        throw new Error('this destroy operation was recorded but its tombstone is not in this keystore');
      }
      return this.receiptFor(recorded);
    }
    const existingTomb = this.readTombstone(keyId);
    if (existingTomb) {
      this.writeOp({ operationId, kind: 'destroy', keyId });
      return this.receiptFor(existingTomb);
    }
    // REFUSE to fabricate a tombstone for a key we have no evidence ever existed
    if (!custodianRecordExists(this.keyPath(keyId))) throw new Error('not_found');

    const j: Journal = {
      keyId,
      receiptId: `rcpt_${randomUUID()}`,
      destroyedAt: new Date(this.clock()).toISOString(),
    };
    writeCustodianRecord(this.journalPath(keyId), JOURNAL_SCHEMA, j); // crash fence: intent recorded first
    this.finishDestroy(j);                          // zeroize-replace+unlink key, write tombstone, clear journal
    this.writeOp({ operationId, kind: 'destroy', keyId });
    return this.receiptFor({ keyId, receiptId: j.receiptId, destroyedAt: j.destroyedAt });
  }

  async status(keyId: string): Promise<KeyStatus> {
    if (this.isDestroyed(keyId)) return 'destroyed';
    const kf = this.readKeyFile(keyId);
    if (!kf) return 'not_found';
    return kf.state;
  }

  async listStaleProvisioning(): Promise<StaleProvisioning[]> {
    const now = this.clock();
    const out: StaleProvisioning[] = [];
    // THE SET IS STATED, NOT FILTERED. An entry that is not a wrapped key file this custodian wrote is a
    // refusal here for the same reason it is one in the rewrap: a keystore holding one is a keystore whose
    // contents nobody can enumerate, and a sweep that silently skipped it would report a shorter list as if
    // it were the whole one.
    this.assertDirectoryUnmoved(this.keysDir, this.keysIdentity, 'keystore');
    for (const entry of listKeystoreFiles(this.keysDir)) {
      // BOUND TO ITS OWN NAME, like every other read. A key file copied onto another key's name would
      // otherwise be reported as a stale provisional key that does not exist, and the sweep that acts on
      // this list destroys what it is told about.
      const kf = readKeystoreFile(path.join(this.keysDir, entry), 'the stale-provisioning sweep', entry);
      if (kf.state === 'provisional') out.push({ operationId: kf.operationId, itemId: kf.itemId, keyId: kf.keyId, ageMs: now - kf.createdAt });
    }
    // AND THE DIRECTORY IS STILL THE ONE THE LIST CAME FROM.
    this.assertDirectoryUnmoved(this.keysDir, this.keysIdentity, 'keystore');
    return out;
  }

  /**
   * KEK rotation / rewrap (Phase 4 Stage 4.2, design O5). Re-wraps every LIVE wrapped DEK from
   * `fromKek` to `toKek` in place. It NEVER touches identity ciphertext (that is under the per-item
   * DEK, not the KEK) and NEVER touches tombstones (a destroyed key has no DEK file). Operate with
   * the app quiesced (FileCustodian is single-writer).
   *
   * Properties:
   *  - resumable + idempotent: a file already readable under `toKek` is skipped, so a re-run (or a
   *    run after a crash mid-rotation) finishes the rest and a fully-rotated keystore is a no-op;
   *  - per-file atomic (temp -> fsync -> rename -> fsync(dir)); a crash leaves each file wholly old
   *    or wholly new;
   *  - preserves keyId/itemId/epoch/operationId/state and the raw DEK value; only `wrappedHex` and
   *    `kekVersion` change (legacy files with no `kekVersion` are treated as 0);
   *  - fails closed: if a live file unwraps under NEITHER key (wrong previous KEK / corruption) it
   *    throws WITHOUT mutating that file. The previous KEK is supplied only for this explicit
   *    rotation; normal operation runs single-KEK.
   * Errors never include key material.
   */
  static rewrapKeystore(rootDir: string, opts: { fromKek: Buffer; toKek: Buffer }): { rewrapped: number; skipped: number; total: number } {
    if (opts.fromKek.length !== 32 || opts.toKek.length !== 32) throw new Error('rewrap KEKs must be 32 bytes');
    const keysDir = path.join(path.resolve(rootDir), 'keys');
    // NO KEYSTORE, NOTHING TO SERIALISE. The lock lives in the state directory, and taking one over a
    // directory that holds no keystore would be creating state in order to report there is none.
    if (!keystoreDirectoryExists(keysDir, 'KEK rewrap')) return { rewrapped: 0, skipped: 0, total: 0 };
    return FileCustodian.withWriteLock(rootDir, () => FileCustodian.rewrapKeystoreUnlocked(keysDir, opts));
  }

  private static rewrapKeystoreUnlocked(keysDir: string, opts: { fromKek: Buffer; toKek: Buffer }): { rewrapped: number; skipped: number; total: number } {
    let rewrapped = 0, skipped = 0, total = 0;
    // ---- THE DIRECTORY THE SET CAME FROM, BOUND ON BOTH SIDES OF THE WALK ------------------------------
    //
    // THE HOLE THIS CLOSES. Every per-file check here is a no-follow check on a FILE, and none of them says
    // anything about the DIRECTORY the names were listed from: `readdirSync('<root>/keys')` follows a `keys`
    // that is a symbolic link, so a rewrap could have rewritten somebody else's directory with every
    // individual file check passing. The no-follow boundary escaped through the parent. The identity is taken
    // again at the end, so a directory swapped underneath a long walk is a refusal rather than one rewrap
    // spread over two keystores.
    const identity = keystoreIdentity(keysDir, 'KEK rewrap');
    for (const f of listKeystoreFiles(keysDir, 'KEK rewrap')) {
      total++;
      const p = path.join(keysDir, f);
      const kf = readKeystoreFile(p, 'KEK rewrap', f);
      // already on the new KEK? (idempotent / resumable) — GCM auth makes this decisive.
      try { unwrapDek(opts.toKek, kf.wrappedHex, kf.keyId).fill(0); skipped++; continue; } catch { /* not yet rewrapped */ }
      let dek: Buffer;
      try {
        dek = unwrapDek(opts.fromKek, kf.wrappedHex, kf.keyId);
      } catch {
        throw new Error('KEK rewrap: a key file does not unwrap under the provided previous or new KEK (wrong previous KEK or corrupt keystore)');
      }
      try {
        const next: KeyFile = { ...kf, wrappedHex: wrapDek(opts.toKek, dek, kf.keyId), kekVersion: (kf.kekVersion ?? 0) + 1 };
        writeKeyFile(p, next);
        rewrapped++;
      } finally {
        dek.fill(0);
      }
    }
    assertKeystoreUnmoved(keysDir, identity, 'KEK rewrap');
    return { rewrapped, skipped, total };
  }

  /**
   * Non-mutating KEK rotation preflight. Scans the live wrapped-DEK files and classifies each file
   * with the same unwrap checks as `rewrapKeystore`, but never writes key files. This lets operators
   * rehearse/schedule the explicit rotation command without touching identity ciphertext or DEKs.
   */
  static planRewrapKeystore(rootDir: string, opts: { fromKek: Buffer; toKek: Buffer }): RewrapPlan {
    if (opts.fromKek.length !== 32 || opts.toKek.length !== 32) throw new Error('rewrap KEKs must be 32 bytes');
    const keysDir = path.join(path.resolve(rootDir), 'keys');
    if (!keystoreDirectoryExists(keysDir, 'KEK rewrap preflight')) return { needsRewrap: 0, alreadyCurrent: 0, total: 0 };
    let needsRewrap = 0, alreadyCurrent = 0, total = 0;
    // NO LOCK, DELIBERATELY, AND THE IDENTITY INSTEAD. This runs against BACKUP SETS — a verified set whose
    // manifest is a digest of its own bytes — and creating a lock directory inside one would change the very
    // thing that was verified. What a lock would have given it is obtained the only other way available to a
    // reader: the directory is identified before the walk and again after it, so a preflight cannot report a
    // count spread over two directories. What it still cannot promise is that no file changed mid-walk, and
    // the CALLERS that need that (`runKekMigration`) hold the custodian writer lock across their whole
    // transaction and re-check the set digest afterwards.
    const identity = keystoreIdentity(keysDir, 'KEK rewrap preflight');
    for (const f of listKeystoreFiles(keysDir, 'KEK rewrap preflight')) {
      total++;
      const kf = readKeystoreFile(path.join(keysDir, f), 'KEK rewrap preflight', f);
      try { unwrapDek(opts.toKek, kf.wrappedHex, kf.keyId).fill(0); alreadyCurrent++; continue; } catch { /* not yet rewrapped */ }
      let dek: Buffer;
      try {
        dek = unwrapDek(opts.fromKek, kf.wrappedHex, kf.keyId);
      } catch {
        throw new Error('KEK rewrap preflight: a key file does not unwrap under the provided previous or new KEK (wrong previous/current KEK or corrupt keystore)');
      }
      dek.fill(0);
      needsRewrap++;
    }
    assertKeystoreUnmoved(keysDir, identity, 'KEK rewrap preflight');
    return { needsRewrap, alreadyCurrent, total };
  }

  static wipe(rootDir: string): void {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
