import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync,
  rmdirSync, unlinkSync, writeSync,
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
 * Read a state document, or refuse.
 *
 * `null` ONLY FOR "IT IS NOT THERE". Every other outcome — a link, a special file, an over-long file, bytes
 * that are not JSON, an envelope that does not describe its own contents — is a refusal. A custodian that
 * treated a corrupt key file as an absent one would answer `not_found` for a key that exists, which for a
 * fail-closed reader is indistinguishable from a correct erasure.
 */
export function readStateDocument<T>(path: string, maxBytes = MAX_STATE_BYTES): T | null {
  let fd: number;
  try {
    fd = openStateFile(path);
  } catch (err) {
    if (err instanceof CustodianStateError && err.message.endsWith('is not there')) return null;
    throw err;
  }
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
    if (total !== stats.size) {
      throw new CustodianStateError('the state file changed size while it was being read');
    }
    let envelope: StateEnvelope;
    try {
      envelope = JSON.parse(buffer.subarray(0, total).toString('utf8')) as StateEnvelope;
    } catch {
      throw new CustodianStateError('the state file is not a document this custodian wrote');
    }
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.bytes !== 'number'
      || typeof envelope.digest !== 'string' || !('doc' in envelope)) {
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
  } finally {
    try { closeSync(fd); } catch { /* the read is done either way */ }
  }
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
  const body = JSON.stringify(envelope);
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number;
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, STATE_FILE_MODE);
  } catch {
    throw new CustodianStateError('a custodian state file could not be created');
  }
  try {
    writeSync(fd, Buffer.from(body, 'utf8'));
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

export function createStateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: STATE_DIR_MODE });
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
export function acquireStateLock(stateDir: string, name = '.custodian-writer.lock'): StateLock {
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
