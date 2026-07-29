import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';

// Catalog Authority — read the custody runtime mode marker, on a descriptor, without following a link.
//
// -----------------------------------------------------------------------------------------------------
// WHY A HELPER RATHER THAN THREE LINES OF SHELL.
// -----------------------------------------------------------------------------------------------------
//
// The launcher used to read the marker like this:
//
//     if [ -L "$MARKER_FILE" ] || [ ! -f "$MARKER_FILE" ]; then refuse; fi
//     mode="$(tr -d '[:space:]' < "$MARKER_FILE")"
//
// Three things were wrong with it, and this file decides which key material a stack is wired to:
//
//   1. IT WAS A CHECK ON A NAME FOLLOWED BY A READ OF THAT NAME. Between the `[ -L ]` and the redirect the
//      name can become a symbolic link, and the redirect FOLLOWS one. The check and the read were about two
//      different moments and possibly two different objects.
//   2. `tr -d '[:space:]'` DELETED EVERY SPACE, so a marker holding `boot strap` — which is not a mode this
//      build defines — became `bootstrap`, which is. A reader that repairs its input into validity is worse
//      than one that has no validation at all.
//   3. IT DID NOT MATCH WHAT THE PRODUCT ITSELF CLAIMS. `custody-runtime-mode.ts` reads this file through a
//      bounded no-follow descriptor and exact-matches one of two words; the launcher claimed the same rule
//      and implemented a looser one.
//
// So the read happens once, on a descriptor opened `O_NOFOLLOW`, proved to be a regular file by `fstat`,
// bounded before a byte is allocated, trimmed of surrounding whitespace ONLY, and matched exactly. One of
// two words goes to stdout; anything else is a non-zero exit and a sentence on stderr.
//
// It prints no path and reads nothing else. Exit 0 = a mode; 3 = there is something there this build will
// not read; 4 = nothing is there at all, which the caller treats as the steady state.

const MODES = ['bootstrap', 'root-only'];
const MAX_BYTES = 64;

export const READ_MODE_EXIT_OK = 0;
export const READ_MODE_EXIT_REFUSED = 3;
export const READ_MODE_EXIT_ABSENT = 4;

export function readCustodyModeMarker(path) {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'absent' };
    // A LINK IS NOT AN ABSENCE. `O_NOFOLLOW` turns one into ELOOP at the open, which is the whole point of
    // opening this way: there is no window in which the name is checked and then resolved.
    return { state: 'refused' };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { state: 'refused' };
    if (stats.size > MAX_BYTES) return { state: 'refused' };
    const buffer = Buffer.allocUnsafe(stats.size);
    let total = 0;
    while (total < buffer.byteLength) {
      const read = readSync(fd, buffer, total, buffer.byteLength - total, total);
      if (read <= 0) break;
      total += read;
    }
    if (total !== stats.size) return { state: 'refused' };
    // TRIMMED, NOT STRIPPED. Surrounding whitespace is what a text editor adds; whitespace in the MIDDLE is
    // part of a word this build does not define, and deleting it would invent a valid answer.
    const word = buffer.subarray(0, total).toString('utf8').trim();
    return MODES.includes(word) ? { state: 'mode', mode: word } : { state: 'refused' };
  } catch {
    return { state: 'refused' };
  } finally {
    try { closeSync(fd); } catch { /* the read is the outcome */ }
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? '')) {
  const path = process.argv[2];
  if (typeof path !== 'string' || path === '') {
    process.stderr.write('usage: read-custody-mode.mjs <marker-path>\n');
    process.exit(READ_MODE_EXIT_REFUSED);
  }
  const outcome = readCustodyModeMarker(path);
  if (outcome.state === 'mode') {
    process.stdout.write(outcome.mode);
    process.exit(READ_MODE_EXIT_OK);
  }
  if (outcome.state === 'absent') process.exit(READ_MODE_EXIT_ABSENT);
  process.stderr.write('the custody runtime mode marker is not one this build will read\n');
  process.exit(READ_MODE_EXIT_REFUSED);
}
