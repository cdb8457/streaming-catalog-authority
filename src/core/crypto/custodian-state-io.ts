import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  renameSync, rmdirSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// Phase 281 — reading and writing custodian state as if the directory were hostile, because it is shared.
//
// -----------------------------------------------------------------------------------------------------
// WHAT WAS WRONG WITH `readFileSync(p, 'utf8')` HERE, SPECIFICALLY.
// -----------------------------------------------------------------------------------------------------
//
// The custodian's state directory is a Docker volume or an appdata folder. Backups read it, an operator can
// open it, a restore writes into it, and — on the Unraid stack this product actually ships — it is a bind
// mount under a share. Four things follow, and the previous code handled none of them:
//
//   1. A NAME CAN BE A LINK. `readFileSync` follows one. A `keys/<hash>.json` replaced by a symlink to
//      something else is read as if it were a key file; a wrapped DEK is then written back THROUGH that link.
//      Every read here opens with `O_NOFOLLOW` and asks the descriptor, not the name.
//   2. A FILE CAN BE ENORMOUS. `JSON.parse(readFileSync(...))` on a state file somebody grew is this process
//      deciding to allocate whatever is on disk. Every read is bounded before a byte is taken.
//   3. AN ATOMIC WRITE IS ONLY ATOMIC IF IT COMPLETES. `write -> rename` leaves a whole old file or a whole
//      new one — but a file that was TRUNCATED by something else, or a temp that was renamed after a partial
//      write on a filesystem that reordered, parses as JSON right up until a field is missing. Every document
//      written through here carries its own length and digest, and a document whose bytes do not match what
//      it claims is refused rather than half-believed.
//   4. TWO WRITERS ARE TWO WRITERS. The custodian is single-writer by design and nothing enforced it. A
//      `mkdir` lock does, atomically, and a second writer is refused rather than interleaved.
//
// NOTHING HERE EVER PUTS A VALUE IN AN ERROR. A refusal names the rule. State files hold wrapped key material
// and an error carrying a fragment of one would be the disclosure the whole design exists to prevent.

export class CustodianStateError extends Error {
  readonly code = 'CUSTODIAN_STATE_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'CustodianStateError';
  }
}

/** How large any one custodian state document may be. A key file is a few hundred bytes. */
export const MAX_STATE_BYTES = 1024 * 1024;

/** Files and directories this module creates. Owner-only, always. */
export const STATE_FILE_MODE = 0o600;
export const STATE_DIR_MODE = 0o700;

const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

/**
 * Whether this platform can refuse a symbolic link AT THE OPEN.
 *
 * Stated rather than assumed: Windows has no `O_NOFOLLOW`, so the guarantee there is the weaker "the object
 * this descriptor refers to is a regular file", checked by `fstat` after the open. The shipped deployment is
 * Linux and takes the atomic path. A suite asserts this is reported honestly rather than claimed.
 */
export function noFollowIsAtomicHere(): boolean {
  return NO_FOLLOW !== 0;
}

/**
 * Open one name without following a link, and hand back the descriptor.
 *
 * Where the platform can promise it, `O_NOFOLLOW` refuses at the open — there is no window between deciding
 * what a name is and holding what it named. Where it cannot, the open still happens and `fstat` still proves
 * the object is a regular file; that is a narrower guarantee and it is written down here rather than implied.
 */
function openStateFile(path: string): number {
  try {
    return openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CustodianStateError('the state file is not there');
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new CustodianStateError('the state file is a symbolic link, and this custodian will not follow one');
    }
    throw new CustodianStateError('the state file could not be opened');
  }
}

/** The envelope every document written through here carries, so a partial write cannot parse as complete. */
interface StateEnvelope {
  readonly doc: unknown;
  /** The byte length of the canonical `doc` encoding, so truncation is arithmetic rather than a guess. */
  readonly bytes: number;
  /** A digest over that same encoding. Detects a change that preserved the length. */
  readonly digest: string;
}

function canonical(doc: unknown): string {
  return JSON.stringify(doc);
}

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The EXACT bytes of one state file, bounded, through a no-follow descriptor.
 *
 * WHY RAW BYTES ARE THEIR OWN OPERATION. A rollback has to put back what was there — not a re-encoding of what
 * a parse thought was there. `JSON.parse` followed by `JSON.stringify` is not the identity over a file: key
 * order, whitespace and any number that does not round-trip all change, and the one file this matters for is
 * the sealed KEK ring, whose envelope is AEAD-authenticated over its own contents. So capture and restore work
 * on bytes, and the parse is somebody else's problem.
 *
 * Every rule of the parsed reader still applies: the name is opened without following a link, the object is
 * proved to be a regular file ON THE DESCRIPTOR, and the size is bounded before a byte is allocated.
 *
 * -----------------------------------------------------------------------------------------------------
 * AND THE FILE IS THE SAME SIZE AFTER THE READ AS IT WAS BEFORE IT.
 * -----------------------------------------------------------------------------------------------------
 *
 * THE HOLE THIS CLOSES. The size was taken once, exactly that many bytes were read, and the check afterwards
 * compared the bytes read against THE SIZE FROM BEFORE — which is trivially satisfied while saying nothing
 * about what the file became. A writer appending to the same inode during the read left this returning a
 * PREFIX of the file, and a prefix of a JSON document that happens to close its own brace parses. A caller
 * would then hold a document it believes is whole, whose file is longer than what it read. Growth and
 * shrink are both refusals now, checked on the descriptor after the last byte is taken.
 *
 * THE DESCRIPTOR PINS THE OBJECT, WHICH IS WHY THIS IS A STATEMENT ABOUT THE FILE AND NOT ABOUT THE NAME.
 * Something that replaces the name (write-to-temp then rename — how everything in this module writes) leaves
 * this read on the old inode and cannot affect it. What can affect it is a writer holding the same inode
 * open, which is exactly what this catches.
 */
export function readStateFileBytes(
  path: string,
  maxBytes = MAX_STATE_BYTES,
  faults: StateReadFaults = {},
): Buffer {
  const fd = openStateFile(path);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new CustodianStateError('the state path is not a regular file');
    if (stats.size > maxBytes) throw new CustodianStateError('the state file is larger than this custodian will read');
    const buffer = Buffer.allocUnsafe(stats.size);
    let total = 0;
    while (total < buffer.byteLength) {
      const read = readSync(fd, buffer, total, buffer.byteLength - total, total);
      if (read <= 0) break;
      total += read;
    }
    // A SHORT READ IS NOT A SHORTER FILE. Believing one would make a truncated capture the thing a rollback
    // restores, which is the failure the capture exists to prevent.
    if (total !== stats.size) throw new CustodianStateError('the state file changed size while it was being read');
    // The seam a suite uses to grow the file underneath this read on demand. It stands for any writer holding
    // the same inode open — the only thing that can change what this descriptor refers to.
    faults.afterRead?.();
    const after = fstatSync(fd);
    if (after.size !== stats.size || after.ino !== stats.ino || after.dev !== stats.dev) {
      throw new CustodianStateError('the state file changed size while it was being read');
    }
    return buffer;
  } finally {
    try { closeSync(fd); } catch { /* the read is done either way */ }
  }
}

/**
 * The one seam that makes the growth check testable without racing a real writer.
 *
 * NOT PASSED ANYWHERE IN PRODUCTION. A read that has already returned cannot be shown to have been raced;
 * this makes the race deterministic, which is the only way a suite can watch the refusal happen.
 */
export interface StateReadFaults {
  /** Runs after the last byte is read and before the file is re-interrogated on the descriptor. */
  readonly afterRead?: () => void;
}

/** Whether a state file is THERE, without reading or parsing it. A file that exists but will not parse exists. */
export function stateFileExists(path: string): boolean {
  try {
    const fd = openStateFile(path);
    try { closeSync(fd); } catch { /* it was open, which is the whole answer */ }
    return true;
  } catch (err) {
    // ONLY "IT IS NOT THERE" IS `false`. A link, a special file, a permission refusal — every one of those is
    // something at that name, and answering `false` would let a caller create over it.
    return !(err instanceof CustodianStateError && err.message.endsWith('is not there'));
  }
}

/**
 * Read a state document, or refuse.
 *
 * `null` ONLY FOR "IT IS NOT THERE". Every other outcome — a link, a special file, an over-long file, bytes
 * that are not JSON, an envelope that does not describe its own contents — is a refusal. A custodian that
 * treated a corrupt key file as an absent one would answer `not_found` for a key that exists, which for a
 * fail-closed reader is indistinguishable from a correct erasure.
 */
export function readStateDocument<T>(path: string, maxBytes = MAX_STATE_BYTES): T | null {
  let bytes: Buffer;
  try {
    bytes = readStateFileBytes(path, maxBytes);
  } catch (err) {
    if (err instanceof CustodianStateError && err.message.endsWith('is not there')) return null;
    throw err;
  }
  let envelope: StateEnvelope;
  try {
    envelope = JSON.parse(bytes.toString('utf8')) as StateEnvelope;
  } catch {
    throw new CustodianStateError('the state file is not a document this custodian wrote');
  }
  // THE ENVELOPE'S OWN SHAPE, BEFORE ITS CONTENTS ARE BELIEVED. Closed and exact: these three fields and no
  // others, an integer length that is a length, and a digest that is a digest. A document carrying a fourth
  // field was written by something that does not know this contract, and reading its `doc` anyway would be
  // this custodian deciding which half of a foreign file to trust.
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new CustodianStateError('the state file is not a document this custodian wrote');
  }
  const keys = Object.keys(envelope as unknown as Record<string, unknown>).sort();
  if (keys.length !== 3 || keys[0] !== 'bytes' || keys[1] !== 'digest' || keys[2] !== 'doc') {
    throw new CustodianStateError('the state file is not a document this custodian wrote');
  }
  if (!Number.isInteger(envelope.bytes) || envelope.bytes < 0 || envelope.bytes > maxBytes
    || typeof envelope.digest !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.digest)) {
    throw new CustodianStateError('the state file is not a document this custodian wrote');
  }
  // THE DOCUMENT DESCRIBES ITSELF, so a truncated or altered one is caught before anything reads a field.
  const encoded = canonical(envelope.doc);
  if (Buffer.byteLength(encoded, 'utf8') !== envelope.bytes || digestOf(encoded) !== envelope.digest) {
    throw new CustodianStateError(
      'a custodian state file does not match its own recorded length and digest, so it was written partially '
      + 'or changed underneath. Refused: a half-written key file read as a whole one is worse than none.');
  }
  return envelope.doc as T;
}

/**
 * Write a state document atomically, privately, and self-describing.
 *
 * temp (O_EXCL, 0600) -> write -> fsync -> rename -> fsync(dir). The envelope is what makes the difference
 * between "atomic on a filesystem that honours ordering" and "detectably complete or detectably not".
 */
export function writeStateDocument(path: string, doc: unknown): void {
  const encoded = canonical(doc);
  const envelope: StateEnvelope = {
    doc,
    bytes: Buffer.byteLength(encoded, 'utf8'),
    digest: digestOf(encoded),
  };
  writeStateFileBytes(path, Buffer.from(JSON.stringify(envelope), 'utf8'));
}

/**
 * Put EXACT bytes at a name, atomically and privately. The other half of `readStateFileBytes`.
 *
 * The envelope is the document writer's business, not this one's: a restore puts back bytes that already
 * carried their own length and digest when they were captured, and re-deriving either from a parse would make
 * the restored file a re-encoding rather than the file.
 */
export function writeStateFileBytes(path: string, body: Buffer): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number;
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, STATE_FILE_MODE);
  } catch {
    throw new CustodianStateError('a custodian state file could not be created');
  }
  try {
    // A SHORT WRITE IS NOT AN ERROR, IT IS A RETURN VALUE. `writeSync` may write fewer bytes than it was
    // given — on a pipe, a full filesystem, or a signal — and the previous version ignored what it returned.
    // A state file truncated that way would then fail its own digest on the next read, which is safe but is
    // the wrong failure: the write is what should complete.
    const bytes = body;
    let written = 0;
    while (written < bytes.byteLength) {
      const chunk = writeSync(fd, bytes, written, bytes.byteLength - written, written);
      if (chunk <= 0) throw new CustodianStateError('a custodian state file could not be written in full');
      written += chunk;
    }
    fsyncSync(fd);
  } catch {
    try { closeSync(fd); } catch { /* the refusal below is the outcome */ }
    try { unlinkSync(temp); } catch { /* as above */ }
    throw new CustodianStateError('a custodian state file could not be written');
  }
  try { closeSync(fd); } catch { /* nothing rests on this close */ }
  try {
    renameSync(temp, path);
  } catch {
    try { unlinkSync(temp); } catch { /* as above */ }
    throw new CustodianStateError('a custodian state file could not be put into place');
  }
  fsyncDirectoryBestEffort(dirname(path));
}

/**
 * Flush the directory entry, so the RENAME survives a crash and not merely the bytes.
 *
 * Best-effort by platform, and said so: Windows cannot fsync a directory handle this way. The shipped
 * deployment is Linux, where it works and where a crash immediately after a rename would otherwise be able to
 * lose the entry even though the file's blocks are durable.
 */
export function fsyncDirectoryBestEffort(directory: string): void {
  let fd: number;
  try {
    fd = openSync(directory, 'r');
  } catch {
    return;
  }
  try { fsyncSync(fd); } catch { /* a platform that will not flush a directory is reported by nothing else */ }
  finally { try { closeSync(fd); } catch { /* as above */ } }
}

/**
 * Create a custodian state directory, and PROVE what was created is the directory this custodian may use.
 *
 * THE HOLE THIS CLOSES. `mkdirSync(p, { recursive: true, mode })` on its own establishes nothing about a name
 * that already exists. If `<state>/ring` is a symbolic link to somebody else's directory, `mkdir` returns
 * EEXIST and the previous version treated that as success — every subsequent write went through the link. And
 * a directory that exists at 0755 (a restore that used `cp -r`, an operator who made it by hand, a bind mount
 * from a share with a permissive default) held the sealed ring where any account on the host could read it,
 * with nothing anywhere saying so.
 *
 * So the directory is opened AFTER the create, without following a link, and interrogated on the DESCRIPTOR:
 * it is a directory, it belongs to this user, and it carries no group or other bit. A failure is a refusal —
 * this function is called immediately before every ring write, so refusing here is refusing before the write.
 */
export function createStateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: STATE_DIR_MODE });
  assertPrivateStateDirectory(path);
}

const O_DIRECTORY = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;

/**
 * WHICH directory a name refers to, established WITHOUT following a link.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND THE HOLE IT CLOSES.
 * -----------------------------------------------------------------------------------------------------
 *
 * Every per-file read in this module refuses a link at the open. That protects the FILES and says nothing
 * about the DIRECTORY they were listed from: `readdirSync('<state>/keys')` follows a `keys` that is a symlink,
 * so a proof that walks "every wrapped key in this keystore" could be walking somebody else's directory with
 * every individual entry check passing. The no-follow boundary escaped through the parent.
 *
 * So a listing is bracketed by this: the name is opened (or `lstat`ed) without following a link, proved to be
 * a directory, and identified by its device and inode. Asking again afterwards and comparing turns "it was not
 * a link when I looked" into "it was the same directory throughout" — which is what a set digest has to be
 * able to say. A caller that only wants the refusal can ignore the identity.
 *
 * PLATFORM, PLAINLY. On POSIX the answer comes from a descriptor opened with `O_NOFOLLOW | O_DIRECTORY`, so
 * there is no window between deciding what the name is and holding what it named. Where that open fails for
 * any reason other than absence, a link or a non-directory — a permission refusal, a descriptor limit, an I/O
 * error — this REFUSES. It used to fall through to `lstat` there, which is the check the comment says is
 * Windows-only: a POSIX host that would not let this process open the directory got the weaker name-based
 * answer instead, and a caller that asked for descriptor identity was silently handed something else. A
 * proof's boundary is not a thing to downgrade because the first attempt was denied.
 *
 * WINDOWS IS THE ONE FALLBACK, AND IT IS NAMED. It has no `O_NOFOLLOW` and no `O_DIRECTORY`, and opening a
 * directory there is not something this can rely on, so the answer comes from `lstat` — which also does not
 * follow a link, and so still refuses a symlinked keystore, but is a check on a name rather than on an object
 * being held. That is a weaker guarantee and it is stated rather than implied. The shipped deployment is
 * Linux and takes the descriptor path.
 */
export interface StateDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * The one seam that makes the refusal above testable on a host where the open really does succeed.
 *
 * NOT PASSED ANYWHERE IN PRODUCTION — every caller of `stateDirectoryIdentity` passes one argument. It exists
 * because "a permission refusal must not become an `lstat`" is a claim about a branch, and the alternative
 * (chmod-ing a directory and hoping the suite is not running as root, on a platform that has modes at all) is
 * a test that silently does not run.
 */
export interface StateDirectoryOpenFaults {
  readonly open?: (path: string) => number;
  /**
   * Which platform's rule to apply. Defaults to this one.
   *
   * WHY IT IS HERE. "A POSIX open failure is a refusal and a Windows one is the documented fallback" is a
   * statement about two branches, and a suite can only ever be running on one of them. A rule that is only
   * checked on the host that happens to be building it is a rule nobody has checked.
   */
  readonly windows?: boolean;
}

/**
 * WHICH directory, and WHOSE, and reachable by whom — from the one no-follow open.
 *
 * `stateDirectoryIdentity` answers only the first of those because that is all its callers needed. A caller
 * that also has to decide whether a directory is fit to hold key material needs the other two, and the worst
 * way to give it them is a second open of the same name: between two opens the name can become something
 * else, so the answer would be about two objects. One open, one `fstat`, all three facts.
 */
export interface StateDirectoryFacts extends StateDirectoryIdentity {
  /** `null` where the platform has no uid this maps to. Never a guess. */
  readonly uid: number | null;
  /** The raw mode bits, for a caller that has a rule about them. `null` where they mean nothing. */
  readonly mode: number | null;
}

export function stateDirectoryFacts(
  path: string,
  faults: StateDirectoryOpenFaults = {},
): StateDirectoryFacts {
  return interrogateStateDirectory(path, faults);
}

export function stateDirectoryIdentity(
  path: string,
  faults: StateDirectoryOpenFaults = {},
): StateDirectoryIdentity {
  const { dev, ino } = interrogateStateDirectory(path, faults);
  return { dev, ino };
}

/**
 * ONE open, ONE `fstat`, every fact both callers need.
 *
 * Asking twice would be asking about two moments: between two opens a name can become something else, so a
 * caller that took its identity from the first and its ownership from the second would be enforcing a rule
 * against a directory it never identified.
 */
function interrogateStateDirectory(
  path: string,
  faults: StateDirectoryOpenFaults,
): StateDirectoryFacts {
  const windows = faults.windows ?? process.platform === 'win32';
  let fd: number | null = null;
  try {
    const open = faults.open ?? ((p: string) => openSync(p, fsConstants.O_RDONLY | NO_FOLLOW | O_DIRECTORY));
    fd = open(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new CustodianStateError(
        'a custodian state directory is a symbolic link, and this custodian will not follow one. Everything '
        + 'listed from it would be whatever the link points at.');
    }
    if (code === 'ENOENT') throw new CustodianStateError('the state directory is not there');
    if (code === 'ENOTDIR') throw new CustodianStateError('a custodian state path is not a directory');
    // ---- EVERY OTHER FAILURE IS A REFUSAL, EXCEPT ON WINDOWS ----------------------------------------------
    //
    // A POSIX host that would not open this directory has told us something, and it is not "here is a weaker
    // answer". EACCES, EPERM, EMFILE, EIO: in every one of them the descriptor identity this function exists
    // to establish was NOT established, and an `lstat` in its place answers a different question about a name
    // rather than about an object being held. Windows is the stated exception, and the fallback below is the
    // guarantee that platform can actually support.
    if (!windows) {
      throw new CustodianStateError('a custodian state directory could not be opened');
    }
    fd = null;
  }
  if (fd === null) {
    // NO DESCRIPTOR HERE — `lstat`, which still does not follow the link.
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (stats === undefined) throw new CustodianStateError('the state directory is not there');
    if (stats.isSymbolicLink()) {
      throw new CustodianStateError(
        'a custodian state directory is a symbolic link, and this custodian will not follow one. Everything '
        + 'listed from it would be whatever the link points at.');
    }
    if (!stats.isDirectory()) throw new CustodianStateError('a custodian state path is not a directory');
    // WINDOWS REPORTS NEITHER A uid THIS MAPS TO NOR MODE BITS THAT MEAN ANYTHING — a file created 0600 reads
    // back 0666 there. `null` says so; inventing a number would let a caller enforce a rule against a value
    // the platform made up.
    return { dev: stats.dev, ino: stats.ino, uid: null, mode: null };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isDirectory()) throw new CustodianStateError('a custodian state path is not a directory');
    if (windows) return { dev: stats.dev, ino: stats.ino, uid: null, mode: null };
    return { dev: stats.dev, ino: stats.ino, uid: stats.uid, mode: stats.mode };
  } finally {
    try { closeSync(fd); } catch { /* the interrogation is done either way */ }
  }
}

/**
 * A directory this custodian is willing to keep key material in.
 *
 * OWNERSHIP AND MODE ARE POSIX FACTS. Windows has neither a uid this maps to nor mode bits `fstat` reports
 * meaningfully, so the check there is the one the platform can actually support — that the object opened is a
 * directory and not a link — and this says so rather than reporting a guarantee it did not establish. The
 * shipped deployment is Linux.
 */
export function assertPrivateStateDirectory(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW | O_DIRECTORY);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new CustodianStateError(
        'a custodian state directory is a symbolic link, and this custodian will not follow one. Every write '
        + 'into it would land wherever the link points, which is not a directory this custodian created.');
    }
    if (code === 'ENOTDIR') throw new CustodianStateError('a custodian state path is not a directory');
    if (code === 'ENOENT') throw new CustodianStateError('a custodian state directory is not there');
    // Windows cannot open a directory for reading at all. The create above succeeded, so there IS a directory
    // there; what cannot be established here is the ownership rule, and that is stated rather than implied.
    if (process.platform === 'win32') return;
    throw new CustodianStateError('a custodian state directory could not be opened');
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isDirectory()) throw new CustodianStateError('a custodian state path is not a directory');
    if (process.platform === 'win32') return;
    const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
    const uid = typeof getuid === 'function' ? getuid.call(process) : null;
    if (uid !== null && stats.uid !== uid) {
      throw new CustodianStateError('a custodian state directory belongs to another user');
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new CustodianStateError(
        'a custodian state directory is readable or writable by somebody other than its owner. The sealed KEK '
        + 'ring and every wrapped key live in it, so a mode that lets another account in makes all of them '
        + 'that account\'s too. Refused before anything was written.');
    }
  } finally {
    try { closeSync(fd); } catch { /* the interrogation is done either way */ }
  }
}

export interface StateLock {
  release(): void;
}

/**
 * One writer at a time over one custodian state directory.
 *
 * `mkdir` IS THE LOCK, because it is the one filesystem operation that both creates and refuses atomically.
 * The custodian was documented as single-writer and nothing enforced it: two processes provisioning at once
 * could each read a key file, each decide, and each write — with the second silently discarding the first.
 * That is not a corruption a digest catches, because both writes are individually well-formed.
 *
 * A STALE LOCK IS NOT BROKEN AUTOMATICALLY. Guessing whether another process is alive and guessing wrong
 * means two writers, which is the thing being prevented.
 */
/**
 * The one lock every writer of a custodian state directory takes.
 *
 * NAMED HERE RATHER THAN SPELLED IN TWO PLACES, because "the same lock" is the entire claim: the custodian's
 * own writers and the key operations that reason about the SET of wrapped keys have to be excluding each
 * other, and two string literals that happen to match is not a guarantee anybody can check.
 */
export const CUSTODIAN_WRITER_LOCK = '.custodian-writer.lock';

export function acquireStateLock(stateDir: string, name = CUSTODIAN_WRITER_LOCK): StateLock {
  const path = join(stateDir, name);
  try {
    mkdirSync(path, { mode: STATE_DIR_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CustodianStateError(
        'another writer holds this custodian state directory, or one was interrupted and left its lock behind. '
        + 'Two writers over one keystore is how a provision is silently discarded. Wait, or remove the lock '
        + 'directory once you are sure nothing is running.');
    }
    throw new CustodianStateError('the custodian state lock could not be taken');
  }
  return {
    release: () => { try { rmdirSync(path); } catch { /* the next run reports a lock it cannot take */ } },
  };
}
