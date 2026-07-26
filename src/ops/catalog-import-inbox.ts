import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { IMPORT_MAX_BYTES } from '../core/catalog/import-snapshot.js';
import { CATALOG_IMPORT_DIR_ENV } from './catalog-import.js';

// Phase 264 — the read-only IMPORT INBOX the operator UI is allowed to see.
//
// THE ONLY PLACE A SNAPSHOT CAN COME FROM. `CATALOG_IMPORT_DIR` is a container path fixed by the Compose
// file, mounted READ-ONLY from a host folder the operator chose. This module lists the files in exactly that
// one directory, non-recursively, and resolves a NAME the browser sent back to a file inside it. There is no
// other source: no arbitrary host or container path, no URL, no upload, no provider call, no directory walk.
//
// THE BROWSER CONTRIBUTES A NAME AND NOTHING ELSE, and the name is checked against a closed pattern BEFORE it
// touches a filesystem call. `..`, `/`, `\`, a NUL, a leading dot, an absolute path, a UNC path and a
// percent-encoded anything are all refused by the pattern rather than normalised — the parts of a path that
// traversal is made of simply cannot appear in a legal name. Containment is then re-checked after symlink
// resolution on both sides, so even a name that somehow passed could not reach outside the folder.
//
// IT READS BYTES AND RETURNS THEM. It parses nothing, applies nothing, and touches no database. What it
// returns is the exact bytes and their digest, so the thing that was previewed and the thing that is applied
// can be proven to be the same bytes rather than assumed to be.
//
// EVERY LISTING IS BOUNDED. At most `INBOX_MAX_ENTRIES` files are reported; a directory holding more says so
// rather than truncating silently. Anything that is not a plain, bounded, `.json` regular file is SKIPPED and
// counted by reason — a symlink, a subdirectory, a device, an empty file, an oversized file. A skipped entry
// is never listed as a candidate, so nothing an operator can click leads anywhere but a real file here.

/** How many candidates one listing will report. */
export const INBOX_MAX_ENTRIES = 200;
/** How many directory entries are examined before the listing stops looking. */
export const INBOX_MAX_SCAN = 2000;

/**
 * The complete grammar of a name the UI may name.
 *
 * Deliberately narrower than what a filesystem allows. It admits no separator, no `..`, no leading dot, no
 * control character, no space and no character outside a fixed ASCII set — so a traversal is not something
 * this code has to defend against after the fact, it is something that cannot be spelled.
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

const NO_SKIPS: Record<InboxSkipReason, number> = {
  'not-a-regular-file': 0, symlink: 0, 'not-a-json-name': 0, empty: 0, 'too-large': 0, unreadable: 0,
};

/** The configured inbox directory, resolved through symlinks, or `null` when there is none. */
export function inboxRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[CATALOG_IMPORT_DIR_ENV];
  if (configured === undefined || configured.trim() === '') return null;
  try {
    return realpathSync(resolve(configured));
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
 */
export function listImportInbox(env: NodeJS.ProcessEnv = process.env): InboxListing {
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
  const root = inboxRoot(env);
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

  let names: string[];
  try {
    names = readdirSync(root);
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
    let stats: ReturnType<typeof lstatSync>;
    try {
      // lstat, so a symlink is SEEN as a symlink rather than reported as whatever it points at.
      stats = lstatSync(join(root, name));
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    if (stats.isSymbolicLink()) { skipped.symlink += 1; continue; }
    if (!stats.isFile()) { skipped['not-a-regular-file'] += 1; continue; }
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
  /** The absolute container path, for the parser. It is NEVER put in a response. */
  readonly path: string;
  readonly bytes: number;
  /** sha256 of the exact bytes on disk. This is what binds a preview to the apply that follows it. */
  readonly contentDigest: string;
  readonly text: string;
}

/**
 * Resolve a name the UI sent, and read the file behind it.
 *
 * FOUR INDEPENDENT CHECKS, in this order, and every one of them is a refusal rather than a repair:
 *   1. the name matches the closed pattern — no separator, no `..`, no dot-file, no control character;
 *   2. the inbox is configured and resolvable;
 *   3. the resolved real path is INSIDE the resolved inbox root (checked after symlinks on both sides);
 *   4. what is there is a regular, non-empty, bounded file — checked with lstat, before it is read.
 *
 * The size is checked BEFORE the read, so an oversized file is refused rather than pulled into memory and
 * then refused. Messages name the CONSTRAINT, never the path.
 */
export function readInboxFile(name: unknown, env: NodeJS.ProcessEnv = process.env): InboxFile {
  if (typeof name !== 'string' || !INBOX_NAME_RE.test(name)) {
    throw new CatalogInboxError(
      'that is not a name this page can use: a snapshot must be a plain .json file name from the import '
      + 'folder, with no folder part in it');
  }
  const root = inboxRoot(env);
  if (root === null) {
    throw new CatalogInboxError('this installation has no readable import folder configured');
  }
  const candidate = join(root, name);

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new CatalogInboxError('no such snapshot file in the import folder');
  }
  // Containment AFTER symlinks are resolved on both sides. The name grammar already forbids traversal; this
  // is the check that still holds if the file itself is a link planted inside the folder.
  const rel = relative(root, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new CatalogInboxError('that snapshot is not inside the import folder');
  }
  // ...and it must be a DIRECT child. A file two levels down is inside the root and is still not something
  // this listing ever offered, so accepting it would widen the surface past what the UI can show.
  if (rel.split(sep).length !== 1) {
    throw new CatalogInboxError('that snapshot is not directly in the import folder');
  }

  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(real);
  } catch {
    throw new CatalogInboxError('that snapshot could not be read');
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CatalogInboxError('that snapshot is not a regular file');
  }
  if (stats.size === 0) throw new CatalogInboxError('that snapshot file is empty');
  if (stats.size > IMPORT_MAX_BYTES) {
    throw new CatalogInboxError(`that snapshot is larger than the ${IMPORT_MAX_BYTES}-byte limit`);
  }

  let raw: Buffer;
  try {
    raw = readFileSync(real);
  } catch {
    throw new CatalogInboxError('that snapshot could not be read');
  }
  // Re-checked against the BYTES that were actually read, not against the size lstat reported a moment ago.
  // A file that grew between the two is refused rather than half-honoured.
  if (raw.byteLength > IMPORT_MAX_BYTES) {
    throw new CatalogInboxError(`that snapshot is larger than the ${IMPORT_MAX_BYTES}-byte limit`);
  }

  return {
    name,
    path: real,
    bytes: raw.byteLength,
    contentDigest: createHash('sha256').update(raw).digest('hex'),
    text: raw.toString('utf8'),
  };
}
