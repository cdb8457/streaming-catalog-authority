import {
  closeSync, constants as fsConstants, fchmodSync, fchownSync, fstatSync, openSync, readSync, unlinkSync,
  writeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

// Writing the ROOT WRAPPING KEY, on a descriptor, so a path swap cannot matter.
//
// -----------------------------------------------------------------------------------------------------
// WHY THIS IS NOT A SHELL FUNCTION.
// -----------------------------------------------------------------------------------------------------
//
// The shell version checked `[ -L ]`, then `[ -f ]`, then redirected into the path, then `chmod` and `chown`
// the path, then `stat` the path. Every one of those resolves the NAME again. Between any two of them the
// name can become a symbolic link to somewhere else — and this runs as root during setup, so the operations
// that follow would re-mode, re-own and overwrite whatever it now points at. Checking harder does not close
// that: the gap is between the check and the use, and there is one at every step.
//
// So the name is resolved ONCE. `O_CREAT | O_EXCL | O_NOFOLLOW` creates it or fails; `O_NOFOLLOW` on the
// existing-file path refuses a link at the open itself. Everything after that — the bytes, the mode, the
// owner, the verification — is done on the DESCRIPTOR with `write`, `fchmod`, `fchown`, `read` and `fstat`,
// which refer to the object that was opened and cannot be redirected by anything happening to the name.
//
// AND AN EXISTING FILE IS VERIFIED, NEVER REPAIRED. If a root key is already there with the wrong owner or
// mode, this refuses and says so. Silently correcting it would be this script deciding that a key which has
// been readable by another account is fine to keep using.
//
// -----------------------------------------------------------------------------------------------------
// FAIL CLOSED WHERE THE GUARANTEE CANNOT BE ESTABLISHED. NO WARNING PATH.
// -----------------------------------------------------------------------------------------------------
//
// A host with no `O_NOFOLLOW`, or with no file ownership model at all (Windows), cannot produce the thing
// this step exists to produce: a file owned by the sidecar's runtime user and readable by nobody else. An
// earlier version of this file created the key anyway on such a host and printed a warning beside it. That is
// not a custody gate — it is an unprotected root wrapping key plus a sentence, and the setup script that
// called it went on to report a ready installation. So the refusal happens BEFORE ANYTHING IS CREATED, and
// there is no flag, environment variable or platform that turns it into a success.

/**
 * The file holds the encoded key and ONE trailing newline, like every other secret this setup writes.
 *
 * The reader trims either way, so this is a contract choice rather than a functional one — and the contract
 * every other file in `secrets/` already satisfies ("no BOM, no CR, ends with a single newline") is the one
 * an operator, a backup check and this project's own suites can state about all of them at once.
 */
const TRAILING_NEWLINE = true;

/** Owner-read only. Stated once, used for the write, the verification and the refusal text. */
export const CUSTODY_FILE_MODE = 0o400;

export class CustodyRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'CustodyRefused';
  }
}

/**
 * Write EVERY byte, or leave nothing behind.
 *
 * A SHORT WRITE IS NOT AN ERROR, IT IS A RETURN VALUE. `writeSync` may write fewer bytes than it was given —
 * on a full filesystem, a signal, or a network-backed mount — and the previous version called it once and
 * ignored what it returned. A root wrapping key truncated that way is 31 bytes that look like a key: the
 * setup script exits 0, the sidecar starts, and the ring is sealed under something nobody can reproduce.
 *
 * `write` is a parameter so the loop can be driven deterministically by a suite. It defaults to `writeSync`
 * and nothing in this file's guarantees depends on which one is passed — a caller that supplies a hostile
 * writer can make this refuse, and cannot make it succeed with the wrong bytes, because the caller verifies
 * from the descriptor afterwards.
 */
export function writeAllOrRefuse(fd, bytes, write = writeSync) {
  let written = 0;
  while (written < bytes.byteLength) {
    const chunk = write(fd, bytes, written, bytes.byteLength - written, written);
    if (!Number.isInteger(chunk) || chunk <= 0) {
      throw new CustodyRefused('the custody secret could not be written in full');
    }
    written += chunk;
  }
  return written;
}

/**
 * Read the whole file back FROM THE SAME DESCRIPTOR, and prove it is exactly what was written.
 *
 * The size from `fstat` and the bytes from `read` are two different claims and both are made: a file of the
 * right length holding the wrong bytes and a file of the wrong length are different failures, and neither is
 * a root wrapping key.
 */
export function readBackOrRefuse(fd, expected) {
  const stats = fstatSync(fd);
  if (stats.size !== expected.byteLength) {
    throw new CustodyRefused('the custody secret on disk is not the length it was written with');
  }
  const buffer = Buffer.allocUnsafe(stats.size);
  let total = 0;
  while (total < buffer.byteLength) {
    const read = readSync(fd, buffer, total, buffer.byteLength - total, total);
    if (read <= 0) break;
    total += read;
  }
  if (total !== buffer.byteLength || !buffer.equals(expected)) {
    throw new CustodyRefused('the custody secret on disk is not the value that was written');
  }
}

/** A uid or gid: a bounded decimal, not merely "digits". */
export function parseId(value, what) {
  if (!/^[0-9]{1,7}$/.test(value ?? '')) {
    throw new CustodyRefused(`the custody runtime ${what} must be a decimal number of at most 7 digits`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2 ** 31 - 1) {
    throw new CustodyRefused(`the custody runtime ${what} is outside the range a uid or gid can take`);
  }
  return parsed;
}

const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

/**
 * Can this host establish what a root wrapping key file requires? A refusal, or nothing.
 *
 * TWO CONDITIONS, BOTH NECESSARY. Without `O_NOFOLLOW` the name cannot be resolved once. Without a file
 * ownership model there is no owner to give it to and no mode to withhold from anybody else. A host missing
 * either cannot hold this key, and there is no partial version of that.
 */
export function assertPlatformCanHoldCustody(platform = process.platform) {
  if (platform === 'win32') {
    throw new CustodyRefused(
      'this platform has no file ownership model, so a root wrapping key cannot be created here owned by the '
      + 'sidecar runtime user and readable by nobody else. NOTHING WAS CREATED. Run the setup on the host '
      + 'that will actually run the stack.');
  }
  if (NO_FOLLOW === 0) {
    throw new CustodyRefused(
      'this platform cannot open a file without following a symbolic link, so a root wrapping key cannot be '
      + 'created here with the guarantee this step requires. NOTHING WAS CREATED.');
  }
}

/**
 * Create or verify the custody secret. Returns what it did; throws `CustodyRefused` and leaves no partial
 * file behind if it cannot.
 */
export function writeCustodySecret(path, value, uid, gid, write = writeSync) {
  assertPlatformCanHoldCustody();
  const bytes = Buffer.from(TRAILING_NEWLINE ? `${value}\n` : value, 'utf8');
  let fd;
  let created = false;
  try {
    // O_RDWR, so the bytes can be read back from THIS descriptor rather than from the name again.
    fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      CUSTODY_FILE_MODE);
    created = true;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw new CustodyRefused('the custody secret could not be created');
    try {
      // EXISTING: opened read-only, WITHOUT following a link. A symlink at this name fails here with ELOOP
      // rather than being followed, and nothing has been modified at that point.
      fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
    } catch (openErr) {
      if (openErr?.code === 'ELOOP' || openErr?.code === 'EMLINK') {
        throw new CustodyRefused(
          'the custody secret path is a symbolic link. This script will not read, re-mode or overwrite '
          + 'whatever it points at. Remove it deliberately.');
      }
      throw new CustodyRefused('the existing custody secret could not be opened');
    }
  }

  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new CustodyRefused('the custody secret path is not a regular file');

    if (created) {
      writeAllOrRefuse(fd, bytes, write);
      // ON THE DESCRIPTOR, not the path.
      fchmodSync(fd, CUSTODY_FILE_MODE);
      try {
        fchownSync(fd, uid, gid);
      } catch (err) {
        // GIVING A FILE AWAY IS A PRIVILEGED OPERATION. An ordinary user cannot chown to another uid, so a
        // setup run as that user can only produce a key owned by THEM — which the caller decides by passing
        // its own ids. Being asked for somebody else's and being unable is a refusal with the reason, not a
        // key quietly left owned by whoever happened to run the command.
        throw new CustodyRefused(
          `the custody secret could not be given to ${uid}:${gid} (${err?.code ?? 'refused'}). Only a `
          + 'privileged user can hand a file to another account: run the setup as root, or set '
          + 'CATALOG_AUTHORITY_RUNTIME_UID/GID to the user this setup is running as and make the sidecar run '
          + 'as that user.');
      }
      // AND THE BYTES ARE PROVED, not merely written. A perfectly-owned truncated key is still not a key.
      // The descriptor was opened O_RDWR before `fchmod` narrowed the file to owner-read, so it can still be
      // read here — and it reads the object that was opened, not whatever the name now refers to.
      readBackOrRefuse(fd, bytes);
    }

    // RE-READ FROM THE SAME DESCRIPTOR. An exit code is not the state, and this is the state.
    const after = fstatSync(fd);
    if (!after.isFile()) throw new CustodyRefused('the custody secret is not a regular file');
    if ((after.mode & 0o777) !== CUSTODY_FILE_MODE) {
      throw new CustodyRefused(created
        ? 'the custody secret did not end up readable only by its owner'
        : `an existing custody secret is mode 0${(after.mode & 0o777).toString(8)}, not 0400. It has been `
          + 'readable beyond its owner; this script verifies and will not silently repair it. Fix it '
          + 'deliberately, or rotate the root wrapping key.');
    }
    if (after.uid !== uid || after.gid !== gid) {
      throw new CustodyRefused(created
        ? 'the custody secret did not end up owned by the runtime user'
        : `an existing custody secret is owned by ${after.uid}:${after.gid}, not ${uid}:${gid}. This script `
          + 'verifies and will not silently re-own it.');
    }
    return created ? 'created' : 'verified';
  } catch (err) {
    // NOTHING HALF-MADE IS LEFT AT THAT NAME. A partial or unverifiable key file is worse than none: the next
    // run would find it, take the "existing" branch, and verify whatever the failure produced.
    if (created) {
      try { closeSync(fd); } catch { /* the unlink below is what matters */ }
      fd = null;
      try { unlinkSync(path); } catch { /* reported by the refusal being rethrown */ }
    }
    throw err;
  } finally {
    if (fd !== null && fd !== undefined) {
      try { closeSync(fd); } catch { /* the verification above is the outcome */ }
    }
  }
}

// ---- the command line ------------------------------------------------------------------------------------
//
// GUARDED, so a suite can import the functions above without this running. Everything below is argument
// handling; every rule is in the functions.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , path, value, uidText, gidText] = process.argv;
  try {
    if (typeof path !== 'string' || path === '' || typeof value !== 'string') {
      throw new CustodyRefused('usage: write-custody-secret.mjs <path> <value> <uid> <gid>');
    }
    const outcome = writeCustodySecret(path, value, parseId(uidText, 'UID'), parseId(gidText, 'GID'));
    process.stdout.write(outcome === 'created' ? 'created custody secret\n' : 'verified existing custody secret\n');
  } catch (err) {
    process.stderr.write(`REFUSING: ${err instanceof CustodyRefused ? err.message : 'the custody secret could not be established'}\n`);
    process.exit(1);
  }
}
