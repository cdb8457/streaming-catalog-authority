import { constants as fsConstants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { MAX_ROOT_KEY_FILE_BYTES, decodeKey, KekRingError } from '../core/crypto/kek-ring.js';

// Phase 282 — reading a 32-byte key from a file, and from nowhere else.
//
// SEPARATE FROM `readRootWrappingKey` ON PURPOSE. That one is the sidecar's, and its ownership rule is
// deliberately absolute: the root wrapping key seals every KEK an installation has, so a mode that lets
// another account read it makes the whole ring readable by that account. This one reads the LEGACY STATIC KEK
// during a migration — a file the shipped stacks already mount into two containers, which therefore cannot be
// held to a rule it has never satisfied. It is still opened without following a link, still bounded, and
// still never given a value in an error.
//
// The distinction is written down rather than smoothed over, because "we relaxed a check for the migration"
// is exactly the sentence a reviewer should be able to find.

export function readKeyFileNoFollow(path: string, what: string): Buffer {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new KekRingError(`the ${what} file is a symbolic link, and this command will not follow one`);
    }
    throw new KekRingError(`the ${what} file could not be opened`);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new KekRingError(`the ${what} path is not a regular file`);
    if (stats.size > MAX_ROOT_KEY_FILE_BYTES) throw new KekRingError(`the ${what} file is larger than a key file could be`);
    const buffer = Buffer.allocUnsafe(stats.size);
    let total = 0;
    while (total < buffer.byteLength) {
      const read = readSync(fd, buffer, total, buffer.byteLength - total, total);
      if (read <= 0) break;
      total += read;
    }
    const decoded = decodeKey(buffer.subarray(0, total).toString('utf8').trim());
    if (decoded === null) throw new KekRingError(`the ${what} file does not hold exactly 32 bytes, hex or base64 encoded`);
    return decoded;
  } finally {
    try { closeSync(fd); } catch { /* the read is done either way */ }
  }
}
