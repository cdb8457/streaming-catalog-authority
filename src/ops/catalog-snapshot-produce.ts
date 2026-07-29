import { randomBytes } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CatalogExportError,
  produceCatalogSnapshot,
  type ProducedSnapshot,
} from '../core/catalog/external-export.js';
import { INBOX_NAME_RE } from './catalog-import-inbox.js';

// Phase 274 — writing a produced snapshot to disk, atomically, and saying exactly what was produced.
//
// WHY THE FILESYSTEM PART IS ITS OWN MODULE. `core/catalog/external-export.ts` takes a string and returns a
// value; it cannot open a file, and that is what makes "producing a snapshot performs no I/O of its own"
// checkable rather than promised. Everything that touches a descriptor is here, and it is deliberately small
// enough to read in one sitting.
//
// -----------------------------------------------------------------------------------------------------
// THE WRITE IS ATOMIC, AND A HALF-WRITTEN SNAPSHOT CANNOT EXIST AT THE DESTINATION NAME.
// -----------------------------------------------------------------------------------------------------
//
// The bytes go to a temporary file in the SAME directory, are flushed to stable storage with `fsync`, and are
// then `rename`d over the destination. Rename within a directory is atomic on every filesystem this product
// runs on, so a reader — including this product's own import inbox, which is watching that folder — sees
// either the old file or the complete new one, never a prefix. A crash between the two leaves the temporary
// file behind and the destination untouched; the temporary name begins with a dot, which the inbox's own name
// grammar refuses, so a leftover can never be offered as a snapshot.
//
// THE TEMPORARY FILE CANNOT BE A SYMLINK, AND THE GUARANTEE IS THE OPEN'S, NOT A CHECK'S. It is created with
// `O_CREAT | O_EXCL`, which fails if the name exists at all — including as a symbolic link, including a
// dangling one. There is no window in which the name was checked and then followed, because the check IS the
// creation. `O_NOFOLLOW` is added where the platform defines it; it is belt-and-braces here rather than the
// guarantee, which is why this module — unlike the browser-facing inbox — still works on a platform that does
// not define it. The destination is `lstat`ed and refused if it is a symlink, so a rename can never replace
// the target of somebody else's link.
//
// NOTHING HERE EVER CREATES A LINK. There is no `symlink`, no `link` and no recursive directory creation in
// this module. The destination directory must already exist; a producer that created directories would be a
// producer that could be pointed at a path and made to build one.
//
// THE REPORT IS REDACTION-SAFE BY CONSTRUCTION. Counts, digests, closed-set words and a BASE NAME. No title,
// no reference value, no attribute value, no directory and no absolute path appears in it — a produced-file
// report is exactly the kind of thing that ends up in a support bundle.

export const SNAPSHOT_PRODUCE_REPORT = 'phase-274-external-snapshot';
export const SNAPSHOT_PRODUCE_VERSION = 1;

/** The NUL character, spelled without an escape so this file stays plain text end to end. */
const NUL = String.fromCharCode(0);

/**
 * When set, every produced snapshot must land inside this directory, named only by its base name.
 *
 * The same discipline `CATALOG_IMPORT_DIR` applies to reading: an installation that has declared where
 * produced snapshots go cannot be talked into writing one somewhere else. Unset — a developer or a bare CLI
 * run — the operator names any path they can already write, with this process's own privileges and no more.
 */
export const SNAPSHOT_OUT_DIR_ENV = 'CATALOG_SNAPSHOT_OUT_DIR';

export class SnapshotProducePathError extends Error {
  readonly code = 'CATALOG_SNAPSHOT_PATH_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'SnapshotProducePathError';
  }
}

export interface ResolvedOutputPath {
  /** The resolved directory the file will be created in. Never put in a report. */
  readonly directory: string;
  /** The base name. This is the only part of the path any report ever carries. */
  readonly name: string;
  /** The full destination path. Never put in a report. */
  readonly path: string;
}

/**
 * Decide where a produced snapshot goes, and refuse anything that is not a plain file name in a real
 * directory.
 *
 * THE NAME MUST BE ONE THE IMPORT INBOX WOULD OFFER. `INBOX_NAME_RE` — a bare `.json` name, no separator, no
 * leading dot, no control character. Producing a file the product's own panel would then refuse to list would
 * be a workflow with a hole in the middle of it, so the two grammars are the same grammar.
 *
 * MESSAGES NAME THE CONSTRAINT, NEVER THE PATH. A rejected path is usually a mount that is not where somebody
 * thought it was, and echoing host paths into a report that gets pasted into an issue is how a filesystem
 * layout leaves the machine.
 */
export function resolveProducedSnapshotPath(
  requested: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOutputPath {
  if (requested.trim() === '') throw new SnapshotProducePathError('no output file was named');
  if (requested.includes(NUL)) throw new SnapshotProducePathError('the output file name is not a usable path');

  const configured = env[SNAPSHOT_OUT_DIR_ENV];
  const configuredDir = configured === undefined || configured.trim() === '' ? null : configured;

  let directory: string;
  let name: string;
  if (configuredDir !== null) {
    // A BARE NAME ONLY. With a configured output directory there is no legitimate reason to spell a path:
    // allowing one would mean the containment rule is enforced by a comparison rather than by the grammar,
    // and a comparison is something a future edit can weaken.
    if (requested.includes('/') || requested.includes('\\') || isAbsolute(requested)) {
      throw new SnapshotProducePathError(
        `${SNAPSHOT_OUT_DIR_ENV} is set, so the output must be a plain file name inside it, with no folder part`);
    }
    name = requested;
    try {
      directory = realpathSync(resolve(configuredDir));
    } catch {
      throw new SnapshotProducePathError(`the directory named by ${SNAPSHOT_OUT_DIR_ENV} does not exist or cannot be read`);
    }
  } else {
    const full = resolve(requested);
    name = basename(full);
    try {
      directory = realpathSync(dirname(full));
    } catch {
      throw new SnapshotProducePathError('the folder the output file would go in does not exist or cannot be read');
    }
  }

  if (!INBOX_NAME_RE.test(name)) {
    throw new SnapshotProducePathError(
      'the output file must be a plain .json name of letters, digits, dot, dash and underscore — the same '
      + 'names the import panel is willing to offer');
  }

  const path = join(directory, name);
  // Belt-and-braces for the configured case, and the only containment check in the unconfigured one: after
  // resolving the directory through symlinks, the destination must still be exactly one component below it.
  if (relative(directory, path) !== name) {
    throw new SnapshotProducePathError('the output file must be directly inside the folder that was resolved for it');
  }
  return { directory, name, path };
}

export type SnapshotProduceMode = 'preview' | 'write';

export interface SnapshotProductionReport {
  readonly report: typeof SNAPSHOT_PRODUCE_REPORT;
  readonly version: typeof SNAPSHOT_PRODUCE_VERSION;
  readonly ok: boolean;
  readonly mode: SnapshotProduceMode;
  /** The operator's label for the system the export came out of. */
  readonly system: string;
  /** The `source` every produced record carries, and which every derived item id is a function of. */
  readonly source: string;
  readonly entries: number;
  readonly records: number;
  readonly references: number;
  readonly recordsWithoutReferences: number;
  /** sha256 of the export that was read. */
  readonly inputDigest: string;
  /** sha256 of the exact bytes produced. What an operator compares two runs by. */
  readonly contentDigest: string;
  /** The importer's own order-independent digest of the normalized document. */
  readonly snapshotDigest: string;
  readonly bytes: number;
  /** The BASE NAME the snapshot was written as, or null for a preview. Never a directory, never a path. */
  readonly fileName: string | null;
  /** True when an existing file at that name was replaced. */
  readonly replaced: boolean;
  /** Declared, and asserted by this phase's suite against this module's own imports. */
  readonly network: 'none';
  readonly acquisition: 'external-input-only';
  readonly mediaAccess: 'none';
  readonly symlinksCreated: 0;
  readonly notes: readonly string[];
}

export interface ProduceSnapshotInput {
  /** The export document, already read as text by whoever resolved it. */
  readonly text: string;
  /** Where to write it. Omitted for a preview, which writes nothing at all. */
  readonly output?: ResolvedOutputPath;
  /** Replace an existing file at that name. Off by default: producing must not clobber by accident. */
  readonly overwrite?: boolean;
}

/**
 * Produce a snapshot, and — unless this is a preview — write it atomically.
 *
 * A PREVIEW IS STRUCTURALLY INCAPABLE OF WRITING. It is not a flag consulted late: with no `output` there is
 * no path in this function's scope, so there is nothing for a later edit to accidentally write to.
 */
export function produceSnapshotFile(input: ProduceSnapshotInput): SnapshotProductionReport {
  const produced = produceCatalogSnapshot(input.text);
  if (input.output === undefined) {
    return report(produced, 'preview', null, false, [
      'This was a preview. Nothing was written. Re-run with --out <name.json> to produce the file.',
    ]);
  }
  const replaced = writeAtomically(input.output, produced.text, input.overwrite === true);
  return report(produced, 'write', input.output.name, replaced, [
    replaced
      ? 'An existing snapshot of that name was replaced, atomically: a reader saw either the old file or the new one.'
      : 'The snapshot was written atomically: it appeared complete or not at all.',
    'Nothing was imported. Preview it with ops:catalog-import, then apply it.',
  ]);
}

function report(
  produced: ProducedSnapshot,
  mode: SnapshotProduceMode,
  fileName: string | null,
  replaced: boolean,
  notes: readonly string[],
): SnapshotProductionReport {
  return {
    report: SNAPSHOT_PRODUCE_REPORT,
    version: SNAPSHOT_PRODUCE_VERSION,
    ok: true,
    mode,
    system: produced.system,
    source: produced.source,
    entries: produced.entries,
    records: produced.snapshot.items.length,
    references: produced.references,
    recordsWithoutReferences: produced.entriesWithoutReferences,
    inputDigest: produced.inputDigest,
    contentDigest: produced.contentDigest,
    snapshotDigest: produced.snapshot.digest,
    bytes: produced.bytes,
    fileName,
    replaced,
    network: 'none',
    acquisition: 'external-input-only',
    mediaAccess: 'none',
    symlinksCreated: 0,
    notes: [...notes],
  };
}

/**
 * Write `text` to `output.path` so that the name is never observed holding a partial document.
 *
 * Returns whether an existing file was replaced.
 */
export function writeAtomically(output: ResolvedOutputPath, text: string, overwrite: boolean): boolean {
  // WHAT IS ALREADY THERE, ASKED WITH `lstat` SO A SYMLINK IS SEEN AS A SYMLINK rather than reported as
  // whatever it points at. A rename over a symlink would replace the LINK, which is harmless; refusing anyway
  // means a produced snapshot can never be involved in somebody else's link at all.
  let existed = false;
  try {
    const current = lstatSync(output.path);
    existed = true;
    if (current.isSymbolicLink()) {
      throw new SnapshotProducePathError('the output name is a symbolic link, and this command will not write through one');
    }
    if (!current.isFile()) {
      throw new SnapshotProducePathError('the output name is not a regular file');
    }
    if (!overwrite) {
      throw new SnapshotProducePathError('a file of that name is already there; pass --overwrite to replace it');
    }
  } catch (err) {
    if (err instanceof SnapshotProducePathError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SnapshotProducePathError('the output file could not be examined');
    }
  }

  const buffer = Buffer.from(text, 'utf8');
  // A LEADING DOT, ON PURPOSE: `INBOX_NAME_RE` refuses it, so a temporary file left behind by a crash can
  // never be offered to an operator as a snapshot. The random suffix means two producers running at once
  // cannot collide, and `O_EXCL` means a collision would be a refusal rather than a silent overwrite.
  const temporary = join(output.directory, `.${output.name}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  } catch {
    throw new SnapshotProducePathError('a temporary file could not be created beside the output; check the folder is writable');
  }

  try {
    // `fstat` on the descriptor we hold, not on the name: it is the file that was created, and nothing can
    // substitute it afterwards because the name is never mentioned again until the rename.
    if (!fstatSync(fd).isFile()) {
      throw new SnapshotProducePathError('the temporary output is not a regular file');
    }
    let written = 0;
    while (written < buffer.byteLength) {
      written += writeSync(fd, buffer, written, buffer.byteLength - written, null);
    }
    // FLUSHED BEFORE THE RENAME. Without this the rename can be durable while the bytes are not, and a
    // machine that loses power leaves the destination name pointing at a zero-length file — which is the
    // exact "the snapshot appeared and was empty" failure the atomic write exists to prevent.
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(temporary); } catch { /* the write already failed; a leftover temp is not a second failure */ }
    if (err instanceof SnapshotProducePathError) throw err;
    throw new SnapshotProducePathError('the snapshot could not be written');
  }
  closeSync(fd);

  try {
    renameSync(temporary, output.path);
  } catch {
    try { unlinkSync(temporary); } catch { /* as above */ }
    throw new SnapshotProducePathError('the snapshot could not be moved into place');
  }

  // The DIRECTORY entry, flushed too, so the rename itself survives a power loss. Best-effort: opening a
  // directory for fsync is not portable (Windows refuses it), and a produced file that is durable but whose
  // directory entry is not is still strictly better than no attempt at all.
  try {
    const dirFd = openSync(output.directory, fsConstants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* not portable, and not a reason to fail a write that succeeded */ }

  return existed;
}

/** The human-readable summary. Counts, digests, a base name, and nothing else. */
export function renderSnapshotProduction(result: SnapshotProductionReport): string {
  const lines: string[] = [];
  lines.push(`Snapshot production — ${result.mode === 'preview' ? 'PREVIEW (nothing was written)' : 'WRITTEN'}`);
  lines.push(`  external system   ${result.system}`);
  lines.push(`  record source     ${result.source}`);
  lines.push(`  entries read      ${result.entries}`);
  lines.push(`  records produced  ${result.records}`);
  lines.push(`  provider refs     ${result.references}`);
  lines.push(`  without refs      ${result.recordsWithoutReferences}`);
  lines.push(`  input digest      ${result.inputDigest.slice(0, 16)}`);
  lines.push(`  content digest    ${result.contentDigest.slice(0, 16)}`);
  lines.push(`  snapshot digest   ${result.snapshotDigest.slice(0, 16)}`);
  lines.push(`  bytes             ${result.bytes}`);
  if (result.fileName !== null) lines.push(`  written as        ${result.fileName}${result.replaced ? ' (replaced)' : ''}`);
  lines.push(`  network           ${result.network}`);
  lines.push(`  acquisition       ${result.acquisition}`);
  lines.push(`  media access      ${result.mediaAccess}`);
  lines.push(`  symlinks created  ${result.symlinksCreated}`);
  for (const note of result.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${result.ok ? 'OK' : 'INCOMPLETE'}`);
  return lines.join('\n');
}

export { CatalogExportError };
