import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IMPORT_MAX_BYTES } from '../core/catalog/import-snapshot.js';
import { CATALOG_IMPORT_DIR_ENV } from './catalog-import.js';

// Phase 264 — the read-only IMPORT INBOX the operator UI is allowed to see.
//
// THE ONLY PLACE A SNAPSHOT CAN COME FROM. `CATALOG_IMPORT_DIR` is a container path fixed by the Compose
// file, mounted READ-ONLY from a host folder the operator chose. This module lists the files in exactly that
// one directory, non-recursively, and opens a NAME the browser sent inside it. There is no other source: no
// arbitrary host or container path, no URL, no upload, no provider call, no directory walk.
//
// THE BROWSER CONTRIBUTES A NAME AND NOTHING ELSE, and the name is checked against a closed pattern BEFORE it
// touches a filesystem call. `..`, `/`, `\`, a NUL, a leading dot, an absolute path, a UNC path and a
// percent-encoded anything are all refused by the pattern rather than normalised — the parts of a path that
// traversal is made of simply cannot appear in a legal name.
//
// ---------------------------------------------------------------------------------------------------------
// ONE DESCRIPTOR. THE FILE THAT IS CHECKED IS THE FILE THAT IS READ.
// ---------------------------------------------------------------------------------------------------------
//
// THE DEFECT THIS CLOSES. The first version of this module resolved the path, `lstat`ed it, and then read it
// BY PATH. Three separate resolutions of one name, with a window between each. The import folder is
// read-only to the CONTAINER; it is not read-only to whoever is at the host, and it is not read-only to
// anything else that can reach that directory. So between the check and the read, the name could be pointed
// at something else entirely: the checks would pass against a small regular file and the read would return
// whatever the name meant a moment later — a symlink's target, a different file, an unbounded one.
//
// HOW IT IS CLOSED. The name is opened ONCE, and every subsequent question is asked of that DESCRIPTOR:
//
//   1. the name matches the closed grammar (no separator, so the only attacker-reachable component is the
//      final one, which is exactly the component `O_NOFOLLOW` protects);
//   2. the inbox root is resolved once;
//   3. `open(join(root, name), O_RDONLY | O_NOFOLLOW)` — a symlink at that final component makes the OPEN
//      fail, atomically, rather than being detected and then re-raced;
//   4. `fstat(fd)` — asked of the open file description, not of a name. It is the file we hold, and nothing
//      can substitute it afterwards because we never mention the name again;
//   5. the size is enforced from that `fstat` BEFORE any bytes are read;
//   6. the bytes are read from THAT descriptor, bounded, and the size is enforced AGAIN against what was
//      actually read — so a file that grew between the fstat and the read is refused rather than truncated
//      into something that looks valid;
//   7. the descriptor is closed on every path, including every refusal.
//
// THIS IS NOT ANOTHER PATHNAME RECHECK, and deliberately so. Re-resolving the path a second, third or fourth
// time only moves the window; it never closes it. The containment argument is structural instead: the name
// grammar admits no separator, so `join(root, name)` has exactly one component below an already-resolved
// root, and `O_NOFOLLOW` refuses to traverse a link at that component. There is no path left for a rename to
// redirect, because after the open there is no path in use at all.
//
// PLATFORM LIMITATION, STATED RATHER THAN GLOSSED. `O_NOFOLLOW` is POSIX. The shipped product runs in a Linux
// container and gets the guarantee above in full. On a platform whose Node build does not define the flag
// (Windows), the open cannot atomically refuse a link, and this module says so: `noFollowAtOpen` on the
// result is `false`, a best-effort `lstat` pre-check is used in its place, and the residual window is a
// documented property of that platform rather than a silent difference. Everything else — one descriptor,
// `fstat` on it, both size bounds, no re-open by name — holds everywhere.
//
// THE LISTING IS ADVISORY, AND ONLY THE OPEN IS AUTHORITATIVE. `listImportInbox` uses `lstat` to decide what
// to offer, which is inherently a snapshot of a moment. Nothing rests on it: a candidate it offered is
// re-decided from scratch, against a descriptor, when it is actually opened.

/** How many candidates one listing will report. */
export const INBOX_MAX_ENTRIES = 200;
/** How many directory entries are examined before the listing stops looking. */
export const INBOX_MAX_SCAN = 2000;

/**
 * The complete grammar of a name the UI may name.
 *
 * Deliberately narrower than what a filesystem allows. It admits no separator, no `..`, no leading dot, no
 * control character, no space and no character outside a fixed ASCII set — so a traversal is not something
 * this code has to defend against after the fact, it is something that cannot be spelled. It is also what
 * makes `O_NOFOLLOW` sufficient: with no separator there is exactly one component below the root, and that
 * is the component the flag protects.
 */
export const INBOX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

export type InboxSkipReason =
  | 'not-a-regular-file'
  | 'symlink'
  | 'not-a-json-name'
  | 'empty'
  | 'too-large'
  | 'unreadable';

export interface InboxCandidate {
  /** The base name, and never anything else. It is what the UI shows and what it sends back. */
  readonly name: string;
  readonly bytes: number;
}

export type InboxState = 'NOT_CONFIGURED' | 'UNREADABLE' | 'EMPTY' | 'CANDIDATES';

export interface InboxListing {
  readonly state: InboxState;
  readonly candidates: readonly InboxCandidate[];
  /** Skipped entries, counted by reason. Never named — a skipped name is still somebody's filesystem. */
  readonly skipped: Readonly<Record<InboxSkipReason, number>>;
  /** True when the directory held more entries than one listing looks at. */
  readonly truncated: boolean;
  /** Guidance for the state the inbox is actually in. Never an error, never a path. */
  readonly guidance: string;
}

export class CatalogInboxError extends Error {
  readonly code = 'CATALOG_IMPORT_INBOX_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'CatalogInboxError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// The syscall surface, injectable so the race can be PROVED rather than argued about.
// ---------------------------------------------------------------------------------------------------------

export interface InboxStat {
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
}

/**
 * Exactly the calls this module makes, and no convenience above them.
 *
 * It is a syscall surface rather than a file-reading helper on purpose: a test can implement it so the
 * pathname means one thing when it is validated and a different thing when it is opened, which is the only
 * way to demonstrate that a check-to-open race is closed rather than merely believed to be.
 */
export interface InboxFs {
  realpath(path: string): string;
  readdir(path: string): readonly string[];
  /** `null` means "not there". A throw means "there, and it could not be examined". */
  lstat(path: string): InboxStat | null;
  /** Opens and returns a descriptor. Throws to refuse — including ELOOP for a link under `O_NOFOLLOW`. */
  open(path: string, flags: number): number;
  /** Asked of the open file description. Nothing can substitute the file behind an fd. */
  fstat(fd: number): InboxStat;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  close(fd: number): void;
  /** The `O_NOFOLLOW` bit, or `null` on a platform whose Node build does not define it. */
  readonly noFollow: number | null;
}

export const realInboxFs: InboxFs = {
  realpath: (path) => realpathSync(path),
  readdir: (path) => readdirSync(path),
  lstat(path) {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return { isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(), size: stats.size };
  },
  open: (path, flags) => openSync(path, flags),
  fstat(fd) {
    const stats = fstatSync(fd);
    // `fstat` follows nothing: it reports the object the descriptor already refers to. A symlink cannot be
    // observed here at all, which is precisely why the refusal has to happen at the OPEN.
    return { isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink(), size: stats.size };
  },
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd),
  // `undefined` on Windows builds. Reported rather than silently treated as zero, because `flags | 0` would
  // quietly turn "refuse to follow a link" into "follow it".
  noFollow: typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : null,
};

const NO_SKIPS: Record<InboxSkipReason, number> = {
  'not-a-regular-file': 0, symlink: 0, 'not-a-json-name': 0, empty: 0, 'too-large': 0, unreadable: 0,
};

/** The configured inbox directory, resolved through symlinks, or `null` when there is none. */
export function inboxRoot(env: NodeJS.ProcessEnv = process.env, fs: InboxFs = realInboxFs): string | null {
  const configured = env[CATALOG_IMPORT_DIR_ENV];
  if (configured === undefined || configured.trim() === '') return null;
  try {
    return fs.realpath(resolve(configured));
  } catch {
    return null;
  }
}

/**
 * List the snapshot files an operator could import.
 *
 * NEVER THROWS FOR A STATE. An unset variable, a directory that is not there and an empty folder are all
 * ANSWERS — a first-run installation has all three at various moments, and a panel that 500s at one of them
 * is a panel that tells a new operator their product is broken when it is merely new.
 *
 * ADVISORY ONLY. What this offers is what was true when it looked. Nothing rests on it: opening a candidate
 * re-decides every question against a descriptor, so a listing that has gone stale costs a refusal, never a
 * disclosure.
 */
export function listImportInbox(env: NodeJS.ProcessEnv = process.env, fs: InboxFs = realInboxFs): InboxListing {
  const configured = env[CATALOG_IMPORT_DIR_ENV];
  if (configured === undefined || configured.trim() === '') {
    return {
      state: 'NOT_CONFIGURED',
      candidates: [],
      skipped: { ...NO_SKIPS },
      truncated: false,
      guidance: `This installation has no import folder configured, so there is nowhere for a snapshot to come `
        + `from. The shipped Compose files set ${CATALOG_IMPORT_DIR_ENV} and mount your own folder there, `
        + 'read-only. Start the stack from one of them and the panel will find your files.',
    };
  }
  const root = inboxRoot(env, fs);
  if (root === null) {
    return {
      state: 'UNREADABLE',
      candidates: [],
      skipped: { ...NO_SKIPS },
      truncated: false,
      guidance: 'The import folder is configured but cannot be read. Check that the folder you mounted exists '
        + 'on the host, then restart the stack. Nothing about it can be chosen from this page.',
    };
  }

  let names: readonly string[];
  try {
    names = fs.readdir(root);
  } catch {
    return {
      state: 'UNREADABLE',
      candidates: [],
      skipped: { ...NO_SKIPS },
      truncated: false,
      guidance: 'The import folder is mounted but could not be listed. Check the folder\'s permissions on the '
        + 'host, then restart the stack.',
    };
  }

  const skipped: Record<InboxSkipReason, number> = { ...NO_SKIPS };
  const candidates: InboxCandidate[] = [];
  // Sorted so two listings of the same folder are the same listing. A UI whose rows move between reloads is a
  // UI in which somebody clicks the wrong row.
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en'));
  const scanned = sorted.slice(0, INBOX_MAX_SCAN);
  for (const name of scanned) {
    if (candidates.length >= INBOX_MAX_ENTRIES) break;
    if (!INBOX_NAME_RE.test(name)) { skipped['not-a-json-name'] += 1; continue; }
    let stats: InboxStat | null;
    try {
      // lstat, so a symlink is SEEN as a symlink rather than reported as whatever it points at.
      stats = fs.lstat(join(root, name));
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    if (stats === null) { skipped.unreadable += 1; continue; }
    if (stats.isSymbolicLink) { skipped.symlink += 1; continue; }
    if (!stats.isFile) { skipped['not-a-regular-file'] += 1; continue; }
    if (stats.size === 0) { skipped.empty += 1; continue; }
    if (stats.size > IMPORT_MAX_BYTES) { skipped['too-large'] += 1; continue; }
    candidates.push({ name, bytes: stats.size });
  }

  const truncated = sorted.length > scanned.length || candidates.length >= INBOX_MAX_ENTRIES;
  return {
    state: candidates.length === 0 ? 'EMPTY' : 'CANDIDATES',
    candidates,
    skipped,
    truncated,
    guidance: candidates.length === 0
      ? 'The import folder is readable and holds no snapshot this page can offer. Copy a .json snapshot into '
        + 'the folder you mounted for imports, then load this panel again. The format is documented below.'
      : `${candidates.length} snapshot file${candidates.length === 1 ? '' : 's'} found. Choose one and preview `
        + 'it — a preview reads the file and writes nothing at all.',
  };
}

export interface InboxFile {
  readonly name: string;
  /** The path that was OPENED. It is never put in a response, and nothing re-reads it. */
  readonly path: string;
  readonly bytes: number;
  /** sha256 of the exact bytes read from the descriptor. This is what binds a preview to its apply. */
  readonly contentDigest: string;
  readonly text: string;
  /**
   * True when the open itself refused to follow a symlink (`O_NOFOLLOW`).
   *
   * Reported rather than assumed. On a platform whose Node build does not define the flag the refusal is a
   * best-effort `lstat` before the open instead, which leaves a window this module will not pretend it has
   * closed. The shipped product runs on Linux, where this is always `true`.
   */
  readonly noFollowAtOpen: boolean;
}

/**
 * Open a name the UI sent, and read the file behind that descriptor.
 *
 * Every refusal names the CONSTRAINT and never the path. The descriptor is closed on every path out of this
 * function, including each refusal — a refusal that leaks a file descriptor is a refusal that eventually
 * becomes an outage.
 */
export function readInboxFile(
  name: unknown,
  env: NodeJS.ProcessEnv = process.env,
  fs: InboxFs = realInboxFs,
): InboxFile {
  if (typeof name !== 'string' || !INBOX_NAME_RE.test(name)) {
    throw new CatalogInboxError(
      'that is not a name this page can use: a snapshot must be a plain .json file name from the import '
      + 'folder, with no folder part in it');
  }
  const root = inboxRoot(env, fs);
  if (root === null) {
    throw new CatalogInboxError('this installation has no readable import folder configured');
  }
  // The ONLY path this function ever builds, and the only one it ever uses. There is no second resolution,
  // because a second resolution is a second window.
  const path = join(root, name);

  const noFollowAtOpen = fs.noFollow !== null;
  if (!noFollowAtOpen) {
    // DEGRADED, AND SAID SO. Without O_NOFOLLOW the open cannot refuse a link atomically, so a link is
    // looked for first. This is best-effort by construction — the window it leaves is exactly the one
    // O_NOFOLLOW exists to remove — and it is why `noFollowAtOpen` travels on the result.
    let pre: InboxStat | null;
    try {
      pre = fs.lstat(path);
    } catch {
      throw new CatalogInboxError('that snapshot could not be read');
    }
    if (pre === null) throw new CatalogInboxError('no such snapshot file in the import folder');
    if (pre.isSymbolicLink) throw new CatalogInboxError('that snapshot is not a regular file');
  }

  // `| 0` is deliberately NOT used as a fallback: on a platform without the flag that would quietly turn
  // "refuse to follow a link" into "follow it", which is the difference this whole function is about.
  const flags = fs.noFollow === null ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fs.noFollow;
  let fd: number;
  try {
    fd = fs.open(path, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP (Linux) / EMLINK (BSD) is O_NOFOLLOW refusing a symlink. It is a different answer from "not
    // there", and an operator who planted a link deserves to be told which.
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new CatalogInboxError('that snapshot is a symbolic link, and this page will not follow one out of the import folder');
    }
    if (code === 'ENOENT') throw new CatalogInboxError('no such snapshot file in the import folder');
    if (code === 'EISDIR') throw new CatalogInboxError('that snapshot is not a regular file');
    throw new CatalogInboxError('that snapshot could not be read');
  }

  try {
    // FROM HERE ON, NOTHING MENTIONS THE PATH. Every question is asked of `fd`.
    let stats: InboxStat;
    try {
      stats = fs.fstat(fd);
    } catch {
      throw new CatalogInboxError('that snapshot could not be examined');
    }
    // A directory, a device, a socket or a FIFO reached through this name is refused on the descriptor —
    // including one that was substituted after the listing offered it, because this is the object we hold.
    if (!stats.isFile) throw new CatalogInboxError('that snapshot is not a regular file');
    if (stats.size === 0) throw new CatalogInboxError('that snapshot file is empty');
    // BEFORE the read, so an enormous file is refused rather than pulled into memory and then refused.
    if (stats.size > IMPORT_MAX_BYTES) {
      throw new CatalogInboxError(`that snapshot is larger than the ${IMPORT_MAX_BYTES}-byte limit`);
    }

    // ONE BYTE MORE THAN THE FSTAT SAID, and never more than the limit. That extra byte is what detects a
    // file which GREW between the fstat and the read: without it a growing file would be silently truncated
    // at exactly the size we expected and would look like a perfectly valid snapshot. Sizing the buffer from
    // the fstat rather than from the 8 MiB limit also means an ordinary snapshot allocates its own size, not
    // the maximum, on every preview.
    const expected = stats.size;
    const raw = readWholeDescriptor(fs, fd, Math.min(IMPORT_MAX_BYTES + 1, expected + 1));

    // AFTER the read, against what was actually returned rather than against what was promised.
    if (raw.byteLength > expected) {
      throw new CatalogInboxError(
        'that snapshot grew while it was being read, so what was checked is not what was read. Nothing was '
        + 'imported. Copy the file into the import folder complete, then try again.');
    }
    if (raw.byteLength > IMPORT_MAX_BYTES) {
      throw new CatalogInboxError(`that snapshot is larger than the ${IMPORT_MAX_BYTES}-byte limit`);
    }
    if (raw.byteLength === 0) throw new CatalogInboxError('that snapshot file is empty');

    return {
      name,
      path,
      bytes: raw.byteLength,
      // The digest describes the bytes that were READ, never the size that was stat'ed. The two can differ;
      // only one of them is what the apply will be checked against.
      contentDigest: createHash('sha256').update(raw).digest('hex'),
      text: raw.toString('utf8'),
      noFollowAtOpen,
    };
  } finally {
    // Every path, including every throw above.
    try { fs.close(fd); } catch { /* a descriptor that cannot be closed is not a reason to fail an import */ }
  }
}

/**
 * Read a descriptor to EOF, or to `limit` bytes, whichever comes first.
 *
 * Reads from absolute position 0 upward so the result cannot depend on a file offset somebody else moved,
 * and stops at `limit` so a file that is growing while it is read cannot make this allocate without bound.
 * The caller decides what a short or an over-long result MEANS; this function only refuses to run away.
 */
function readWholeDescriptor(fs: InboxFs, fd: number, limit: number): Buffer {
  if (limit <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(limit);
  let total = 0;
  for (;;) {
    if (total >= limit) break;
    let read: number;
    try {
      read = fs.read(fd, buffer, total, limit - total, total);
    } catch {
      throw new CatalogInboxError('that snapshot could not be read');
    }
    if (read <= 0) break;
    total += read;
  }
  return buffer.subarray(0, total);
}
